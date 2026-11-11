import { createHash, randomBytes } from 'node:crypto';
import type { Queryable } from './db.js';
import type { Actor, TierRank } from './types.js';

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function generateToken(): string {
  return `cp_${randomBytes(24).toString('base64url')}`;
}

export function tokenPrefix(raw: string): string {
  return raw.slice(0, 7);
}

interface ActorRow {
  user_id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  token_id: string;
  kind: 'human' | 'agent';
  ceiling_tier: TierRank;
  curated: string[];
  owned: string[];
}

const actorSelect = `
  select u.id as user_id, u.email, u.name, u.role, t.id as token_id, t.kind, t.ceiling_tier,
    coalesce((select array_agg(domain_id) from domain_curators dc where dc.user_id = u.id), '{}') as curated,
    coalesce((select array_agg(id) from domains d where d.owner_id = u.id), '{}') as owned
  from api_tokens t join users u on u.id = t.user_id`;

function toActor(row: ActorRow): Actor {
  return {
    userId: row.user_id,
    email: row.email,
    name: row.name,
    role: row.role,
    tokenId: row.token_id,
    tokenKind: row.kind,
    ceiling: row.ceiling_tier,
    curatedDomainIds: new Set(row.curated),
    ownedDomainIds: new Set(row.owned),
  };
}

export async function actorFromToken(db: Queryable, raw: string): Promise<Actor | null> {
  const hash = hashToken(raw);
  let { rows } = await db.query<ActorRow>(`${actorSelect} where t.token_hash = $1 and t.revoked_at is null`, [hash]);
  if (!rows[0] && raw.startsWith('cpa_')) {
    ({ rows } = await db.query<ActorRow>(
      `${actorSelect} join oauth_tokens o on o.grant_id = t.id
       where o.token_hash = $1 and o.kind = 'access' and o.expires_at > now() and t.revoked_at is null`,
      [hash],
    ));
  }
  if (!rows[0]) return null;
  await db.query('update api_tokens set last_used_at = now() where id = $1', [rows[0].token_id]);
  return toActor(rows[0]);
}

export async function actorFromSession(db: Queryable, sessionId: string): Promise<Actor | null> {
  const { rows } = await db.query<ActorRow>(
    `${actorSelect} join sessions s on s.token_id = t.id where s.id = $1 and s.expires_at > now() and t.revoked_at is null`,
    [sessionId],
  );
  return rows[0] ? toActor(rows[0]) : null;
}

/** The user as if acting with full human trust. Used to work out who is able to approve a request. */
export async function humanActorFor(db: Queryable, userId: string): Promise<Actor | null> {
  const { rows } = await db.query<Omit<ActorRow, 'token_id' | 'kind' | 'ceiling_tier'>>(
    `select u.id as user_id, u.email, u.name, u.role,
       coalesce((select array_agg(domain_id) from domain_curators dc where dc.user_id = u.id), '{}') as curated,
       coalesce((select array_agg(id) from domains d where d.owner_id = u.id), '{}') as owned
     from users u where u.id = $1`,
    [userId],
  );
  return rows[0] ? toActor({ ...rows[0], token_id: '', kind: 'human', ceiling_tier: 1 }) : null;
}

export async function createSession(db: Queryable, actor: Actor): Promise<string> {
  const id = randomBytes(32).toString('base64url');
  await db.query(`insert into sessions (id, user_id, token_id, expires_at) values ($1, $2, $3, now() + interval '30 days')`, [
    id,
    actor.userId,
    actor.tokenId,
  ]);
  return id;
}

export async function destroySession(db: Queryable, sessionId: string): Promise<void> {
  await db.query('delete from sessions where id = $1', [sessionId]);
}
