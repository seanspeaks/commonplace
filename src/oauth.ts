import { randomBytes, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { InvalidGrantError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { hashToken } from './auth.js';
import { withTx, type Db, type Queryable } from './db.js';
import { invalid, notFound } from './errors.js';
import { audit } from './services/audit.js';
import type { Actor, TierRank } from './types.js';

export const OAUTH_SCOPE = 'commonplace';
const ACCESS_TTL_SECONDS = 3600;
const REFRESH_TTL = '30 days';
const CODE_TTL = '5 minutes';
const PENDING_TTL = '10 minutes';

const newSecret = (prefix: string) => `${prefix}${randomBytes(32).toString('base64url')}`;

export interface PendingAuthorization {
  id: string;
  client: OAuthClientInformationFull;
  redirectUri: string;
}

async function getClient(db: Queryable, clientId: string): Promise<OAuthClientInformationFull | undefined> {
  const { rows } = await db.query<{ metadata: OAuthClientInformationFull }>('select metadata from oauth_clients where client_id = $1', [clientId]);
  return rows[0]?.metadata;
}

export class CommonplaceOAuthProvider implements OAuthServerProvider {
  readonly resourceUrl: URL;
  readonly clientsStore: OAuthRegisteredClientsStore;

  constructor(
    private readonly db: Db,
    private readonly publicUrl: string,
  ) {
    this.resourceUrl = new URL(`${publicUrl}/mcp`);
    // Secrets are stored hashed and checked by confidentialClientAuth before the SDK sees the request,
    // so the stored metadata never carries client_secret and the SDK's plaintext comparison is skipped.
    this.clientsStore = {
      getClient: (clientId) => getClient(db, clientId),
      registerClient: async (client) => {
        const { client_secret, ...metadata } = client as OAuthClientInformationFull;
        if (!metadata.client_id) throw new Error('client_id was not generated');
        await db.query('insert into oauth_clients (client_id, client_secret_hash, metadata) values ($1, $2, $3)', [
          metadata.client_id,
          client_secret ? hashToken(client_secret) : null,
          metadata,
        ]);
        return client as OAuthClientInformationFull;
      },
    };
  }

  private checkResource(resource?: URL | string | null) {
    if (!resource) return;
    const normalized = String(resource).replace(/#.*$/, '').replace(/\/$/, '');
    if (normalized !== this.resourceUrl.href && normalized !== this.publicUrl) {
      throw new InvalidTargetError(`This server only issues tokens for ${this.resourceUrl.href}`);
    }
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    this.checkResource(params.resource);
    const id = randomBytes(24).toString('base64url');
    await this.db.query('delete from oauth_pending where expires_at < now()');
    await this.db.query(
      `insert into oauth_pending (id, client_id, redirect_uri, code_challenge, state, scopes, resource, expires_at)
       values ($1, $2, $3, $4, $5, $6, $7, now() + interval '${PENDING_TTL}')`,
      [id, client.client_id, params.redirectUri, params.codeChallenge, params.state ?? null, params.scopes ?? [], params.resource?.href ?? null],
    );
    res.redirect(302, `/oauth/consent/${id}`);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string): Promise<string> {
    const { rows } = await this.db.query<{ code_challenge: string }>(
      'select code_challenge from oauth_codes where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now()',
      [hashToken(code), client.client_id],
    );
    if (!rows[0]) throw new InvalidGrantError('Invalid or expired authorization code');
    return rows[0].code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    this.checkResource(resource);
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<{ user_id: string; ceiling_tier: TierRank; redirect_uri: string; scopes: string[] }>(
        `update oauth_codes set used_at = now()
         where code_hash = $1 and client_id = $2 and used_at is null and expires_at > now()
         returning user_id, ceiling_tier, redirect_uri, scopes`,
        [hashToken(code), client.client_id],
      );
      const row = rows[0];
      if (!row) throw new InvalidGrantError('Invalid or expired authorization code');
      if (redirectUri !== undefined && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri does not match the authorization request');
      const grantId = await this.upsertGrant(tx, row.user_id, client, row.ceiling_tier);
      return this.issueTokens(tx, grantId);
    });
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, _scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    this.checkResource(resource);
    const hash = hashToken(refreshToken);
    const { rows } = await this.db.query<{ grant_id: string; user_id: string; oauth_client_id: string; revoked: boolean; used: boolean; expired: boolean }>(
      `select o.grant_id, g.user_id, g.oauth_client_id, g.revoked_at is not null as revoked, o.used_at is not null as used, o.expires_at <= now() as expired
       from oauth_tokens o join api_tokens g on g.id = o.grant_id
       where o.token_hash = $1 and o.kind = 'refresh'`,
      [hash],
    );
    const row = rows[0];
    if (!row || row.oauth_client_id !== client.client_id || row.revoked || row.expired) throw new InvalidGrantError('Invalid or expired refresh token');
    return withTx(this.db, async (tx) => {
      const marked = await tx.query(`update oauth_tokens set used_at = now() where token_hash = $1 and used_at is null`, [hash]);
      if (row.used || !marked.rowCount) {
        // A rotated refresh token came back: someone else may hold a copy, so end the whole connection.
        await tx.query('update api_tokens set revoked_at = now() where id = $1 and revoked_at is null', [row.grant_id]);
        await tx.query('delete from oauth_tokens where grant_id = $1', [row.grant_id]);
        await audit(tx, { actorId: row.user_id, tokenId: row.grant_id, action: 'oauth.refresh_reuse', targetKind: 'token', targetId: row.grant_id });
        return null;
      }
      return this.issueTokens(tx, row.grant_id);
    }).then((tokens) => {
      if (!tokens) throw new InvalidGrantError('This refresh token was already used, so the connection was revoked. Reconnect to continue.');
      return tokens;
    });
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const { rows } = await this.db.query<{ oauth_client_id: string; scopes: string[]; expires_at: Date }>(
      `select g.oauth_client_id, o.scopes, o.expires_at from oauth_tokens o join api_tokens g on g.id = o.grant_id
       where o.token_hash = $1 and o.kind = 'access' and o.expires_at > now() and g.revoked_at is null`,
      [hashToken(token)],
    );
    if (!rows[0]) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token,
      clientId: rows[0].oauth_client_id,
      scopes: rows[0].scopes,
      expiresAt: Math.floor(rows[0].expires_at.getTime() / 1000),
      resource: this.resourceUrl,
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const { rows } = await this.db.query<{ grant_id: string; kind: 'access' | 'refresh' }>(
      `select o.grant_id, o.kind from oauth_tokens o join api_tokens g on g.id = o.grant_id where o.token_hash = $1 and g.oauth_client_id = $2`,
      [hashToken(request.token), client.client_id],
    );
    const row = rows[0];
    if (!row) return;
    if (row.kind === 'access') {
      await this.db.query('delete from oauth_tokens where token_hash = $1', [hashToken(request.token)]);
      return;
    }
    await this.db.query('update api_tokens set revoked_at = now() where id = $1 and revoked_at is null', [row.grant_id]);
    await this.db.query('delete from oauth_tokens where grant_id = $1', [row.grant_id]);
  }

  /** One grant per person and client: reconnecting updates it instead of piling up rows under Settings. */
  private async upsertGrant(tx: Queryable, userId: string, client: OAuthClientInformationFull, ceiling: TierRank): Promise<string> {
    const name = `${(client.client_name ?? 'MCP client').slice(0, 80)} (OAuth)`;
    const existing = await tx.query<{ id: string }>(
      'update api_tokens set ceiling_tier = $3, name = $4 where user_id = $1 and oauth_client_id = $2 and revoked_at is null returning id',
      [userId, client.client_id, ceiling, name],
    );
    const grantId =
      existing.rows[0]?.id ??
      (
        await tx.query<{ id: string }>(
          `insert into api_tokens (user_id, name, kind, ceiling_tier, token_hash, prefix, oauth_client_id)
           values ($1, $2, 'agent', $3, $4, 'oauth', $5) returning id`,
          [userId, name, ceiling, hashToken(newSecret('cpg_')), client.client_id],
        )
      ).rows[0].id;
    await audit(tx, { actorId: userId, tokenId: grantId, action: 'oauth.grant', targetKind: 'token', targetId: grantId, after: { client: name, ceiling_tier: ceiling } });
    return grantId;
  }

  private async issueTokens(tx: Queryable, grantId: string): Promise<OAuthTokens> {
    const access = newSecret('cpa_');
    const refresh = newSecret('cpr_');
    await tx.query(`delete from oauth_tokens where grant_id = $1 and (expires_at < now() or used_at < now() - interval '1 day')`, [grantId]);
    await tx.query(
      `insert into oauth_tokens (token_hash, grant_id, kind, scopes, expires_at) values
         ($1, $3, 'access', $4, now() + make_interval(secs => $5)),
         ($2, $3, 'refresh', $4, now() + interval '${REFRESH_TTL}')`,
      [hashToken(access), hashToken(refresh), grantId, [OAUTH_SCOPE], ACCESS_TTL_SECONDS],
    );
    return { access_token: access, token_type: 'Bearer', expires_in: ACCESS_TTL_SECONDS, refresh_token: refresh, scope: OAUTH_SCOPE };
  }
}

// ---------- consent, used by the UI ----------

export async function getPending(db: Queryable, id: string): Promise<PendingAuthorization | null> {
  const { rows } = await db.query<{ id: string; client_id: string; redirect_uri: string }>(
    'select id, client_id, redirect_uri from oauth_pending where id = $1 and expires_at > now()',
    [id],
  );
  if (!rows[0]) return null;
  const client = await getClient(db, rows[0].client_id);
  return client ? { id: rows[0].id, client, redirectUri: rows[0].redirect_uri } : null;
}

async function takePending(db: Queryable, id: string) {
  const { rows } = await db.query<{ client_id: string; redirect_uri: string; code_challenge: string; state: string | null; scopes: string[]; resource: string | null }>(
    'delete from oauth_pending where id = $1 and expires_at > now() returning client_id, redirect_uri, code_challenge, state, scopes, resource',
    [id],
  );
  if (!rows[0]) throw notFound('This connection request expired or was already answered. Start it again from your app.');
  return rows[0];
}

/** Approves a pending request for the signed-in person and returns where to send the browser. */
export async function approvePending(db: Db, actor: Actor, id: string, ceiling: number): Promise<string> {
  if (actor.tokenKind !== 'human') throw invalid('Sign in as a person to approve connections');
  if (![2, 3, 4].includes(ceiling)) throw invalid('Pick Verified, Working or Raw as the highest tier this app can write');
  const p = await takePending(db, id);
  const code = newSecret('cpc_');
  await db.query('delete from oauth_codes where expires_at < now() - interval \'1 day\'');
  await db.query(
    `insert into oauth_codes (code_hash, client_id, user_id, ceiling_tier, redirect_uri, code_challenge, scopes, resource, expires_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, now() + interval '${CODE_TTL}')`,
    [hashToken(code), p.client_id, actor.userId, ceiling, p.redirect_uri, p.code_challenge, p.scopes, p.resource],
  );
  const target = new URL(p.redirect_uri);
  target.searchParams.set('code', code);
  if (p.state !== null) target.searchParams.set('state', p.state);
  return target.href;
}

export async function denyPending(db: Queryable, id: string): Promise<string> {
  const p = await takePending(db, id);
  const target = new URL(p.redirect_uri);
  target.searchParams.set('error', 'access_denied');
  target.searchParams.set('error_description', 'The person declined the connection');
  if (p.state !== null) target.searchParams.set('state', p.state);
  return target.href;
}

// ---------- wiring ----------

function equalHashes(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Checks confidential clients against their hashed secret (client_secret_post or client_secret_basic). */
function confidentialClientAuth(db: Db): RequestHandler[] {
  return [
    express.urlencoded({ extended: false }),
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'POST') return next();
      const body = (req.body ??= {}) as Record<string, string | undefined>;
      let clientId = body.client_id;
      let secret = body.client_secret;
      const header = req.get('authorization') ?? '';
      if (header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString();
        const i = decoded.indexOf(':');
        clientId = decodeURIComponent(i < 0 ? decoded : decoded.slice(0, i));
        secret = i < 0 ? undefined : decodeURIComponent(decoded.slice(i + 1));
        body.client_id ??= clientId;
      }
      if (!clientId) return next();
      try {
        const { rows } = await db.query<{ client_secret_hash: string | null }>('select client_secret_hash from oauth_clients where client_id = $1', [clientId]);
        const stored = rows[0]?.client_secret_hash;
        if (stored && (!secret || !equalHashes(hashToken(secret), stored))) {
          res.status(401).set('Cache-Control', 'no-store').json({ error: 'invalid_client', error_description: 'Client authentication failed' });
          return;
        }
        delete body.client_secret;
        next();
      } catch (err) {
        next(err);
      }
    },
  ];
}

export function oauthRouter(db: Db, publicUrl: string): { router: express.Router; resourceMetadataUrl: string } {
  const provider = new CommonplaceOAuthProvider(db, publicUrl);
  const router = express.Router();
  router.use(['/token', '/revoke'], ...confidentialClientAuth(db));
  router.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(publicUrl),
      resourceServerUrl: provider.resourceUrl,
      scopesSupported: [OAUTH_SCOPE],
      resourceName: 'Commonplace',
    }),
  );
  return { router, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(provider.resourceUrl) };
}
