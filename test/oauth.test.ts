import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createApp } from '../src/app.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let server: Server;
let base: string;
let cookie: string;

const REDIRECT = 'http://127.0.0.1:8976/callback';

before(async () => {
  env = await setup();
  server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { app } = await createApp(env.db, { publicUrl: base, oauth: true });
  server.on('request', app);

  const login = await fetch(`${base}/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
    body: new URLSearchParams({ token: env.adminToken }),
  });
  cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^cp_session=/);
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await env.close();
});

const form = (fields: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: 'POST',
  redirect: 'manual' as const,
  headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base, ...headers },
  body: new URLSearchParams(fields),
});

function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
}

async function register(extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Agent', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none', ...extra }),
  });
  assert.equal(res.status, 201);
  return (await res.json()) as { client_id: string; client_secret?: string };
}

/** Runs authorize + consent and returns the redirect the browser would follow. */
async function authorize(clientId: string, challenge: string, decision: 'approve' | 'deny' = 'approve', ceiling = '4') {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    resource: `${base}/mcp`,
  });
  const auth = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  assert.equal(auth.status, 302);
  const consentPath = auth.headers.get('location')!;
  assert.match(consentPath, /^\/oauth\/consent\//);

  const page = await fetch(`${base}${consentPath}`, { headers: { cookie } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Connect Test Agent\?/);

  const answer = await fetch(`${base}${consentPath}`, form({ decision, ceiling_tier: ceiling }, { cookie }));
  assert.equal(answer.status, 303);
  return new URL(answer.headers.get('location')!);
}

async function token(fields: Record<string, string>, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/token`, form(fields, headers));
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

async function connect(accessToken: string) {
  const client = new Client({ name: 'oauth-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
  return client;
}

async function whoami(client: Client) {
  const result = (await client.callTool({ name: 'whoami', arguments: {} })) as { content: { text: string }[] };
  return JSON.parse(result.content[0].text) as { name: string; token: string; write_ceiling: string };
}

test('advertises discovery metadata and points 401s at it', async () => {
  const challenge = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(challenge.status, 401);
  const header = challenge.headers.get('www-authenticate') ?? '';
  const prmUrl = /resource_metadata="([^"]+)"/.exec(header)?.[1];
  assert.equal(prmUrl, `${base}/.well-known/oauth-protected-resource/mcp`);

  const prm = (await (await fetch(prmUrl!)).json()) as { resource: string; authorization_servers: string[] };
  assert.equal(prm.resource, `${base}/mcp`);
  const as = (await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
  assert.equal(as.issuer, prm.authorization_servers[0]);
  assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
  assert.equal(as.registration_endpoint, `${base}/register`);
});

test('a client registers, gets consent, and works over MCP at the chosen ceiling', async () => {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const redirect = await authorize(client_id, challenge, 'approve', '3');
  assert.equal(redirect.origin + redirect.pathname, REDIRECT);
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  const code = redirect.searchParams.get('code')!;

  const wrong = await token({ grant_type: 'authorization_code', code, code_verifier: pkce().verifier, redirect_uri: REDIRECT, client_id });
  assert.equal(wrong.status, 400, 'a mismatched PKCE verifier is refused');

  const ok = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id, resource: `${base}/mcp` });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.access_token, /^cpa_/);
  assert.match(ok.body.refresh_token, /^cpr_/);

  const reused = await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id });
  assert.equal(reused.status, 400, 'codes are single use');

  const me = await whoami(await connect(ok.body.access_token));
  assert.equal(me.token, 'agent');
  assert.match(me.write_ceiling, /Working/);

  const grants = await env.db.query<{ name: string }>(`select name from api_tokens where oauth_client_id = $1 and revoked_at is null`, [client_id]);
  assert.deepEqual(grants.rows.map((r) => r.name), ['Test Agent (OAuth)']);
});

test('refresh tokens rotate, and replaying an old one revokes the connection', async () => {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const code = (await authorize(client_id, challenge)).searchParams.get('code')!;
  const first = (await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id })).body;

  const second = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id });
  assert.equal(second.status, 200);
  assert.notEqual(second.body.refresh_token, first.refresh_token);
  assert.equal((await whoami(await connect(second.body.access_token))).token, 'agent');

  const replay = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id });
  assert.equal(replay.status, 400);
  const after = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${second.body.access_token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(after.status, 401, 'the whole grant is revoked after a replay');
  assert.match(after.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
});

test('revoking the grant under Settings cuts off the client', async () => {
  const { client_id } = await register();
  const { verifier, challenge } = pkce();
  const code = (await authorize(client_id, challenge)).searchParams.get('code')!;
  const tokens = (await token({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id })).body;
  const { rows } = await env.db.query<{ id: string }>('select id from api_tokens where oauth_client_id = $1', [client_id]);

  const revoke = await fetch(`${base}/settings/tokens/${rows[0].id}/revoke`, form({}, { cookie }));
  assert.equal(revoke.status, 303);
  const refreshed = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id });
  assert.equal(refreshed.status, 400);
  await assert.rejects(connect(tokens.access_token));
});

test('denying consent sends access_denied back to the client', async () => {
  const { client_id } = await register();
  const redirect = await authorize(client_id, pkce().challenge, 'deny');
  assert.equal(redirect.searchParams.get('error'), 'access_denied');
  assert.equal(redirect.searchParams.get('state'), 'xyz');
  assert.equal(redirect.searchParams.get('code'), null);
});

test('confidential clients must present their secret, stored only as a hash', async () => {
  const { client_id, client_secret } = await register({ token_endpoint_auth_method: 'client_secret_post' });
  assert.ok(client_secret);
  const stored = await env.db.query<{ client_secret_hash: string; metadata: Record<string, unknown> }>('select * from oauth_clients where client_id = $1', [client_id]);
  assert.notEqual(stored.rows[0].client_secret_hash, client_secret);
  assert.equal(stored.rows[0].metadata.client_secret, undefined);

  const { verifier, challenge } = pkce();
  const code = (await authorize(client_id, challenge)).searchParams.get('code')!;
  const exchange = { grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: REDIRECT, client_id };
  assert.equal((await token(exchange)).status, 401);
  assert.equal((await token({ ...exchange, client_secret: 'nope' })).status, 401);
  const basic = `Basic ${Buffer.from(`${client_id}:${client_secret}`).toString('base64')}`;
  assert.equal((await token(exchange, { authorization: basic })).status, 200);
});

test('consent needs a signed-in person and returns them to it after login', async () => {
  const { client_id } = await register();
  const params = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: 'S256' });
  const consentPath = (await fetch(`${base}/authorize?${params}`, { redirect: 'manual' })).headers.get('location')!;
  const anon = await fetch(`${base}${consentPath}`, { redirect: 'manual' });
  assert.equal(anon.status, 303);
  assert.equal(anon.headers.get('location'), `/login?next=${encodeURIComponent(consentPath)}`);

  const login = await fetch(`${base}/login`, form({ token: env.adminToken, next: consentPath }));
  assert.equal(login.headers.get('location'), consentPath);
  const offsite = await fetch(`${base}/login`, form({ token: env.adminToken, next: '//evil.example/' }));
  assert.equal(offsite.headers.get('location'), '/');
});

test('tokens for another resource are refused', async () => {
  const { client_id } = await register();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: REDIRECT,
    code_challenge: pkce().challenge,
    code_challenge_method: 'S256',
    resource: 'https://other.example/mcp',
  });
  const res = await fetch(`${base}/authorize?${params}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(new URL(res.headers.get('location')!).searchParams.get('error'), 'invalid_target');
});

test("the SDK's own OAuth client discovers, registers and connects", async () => {
  let info: OAuthClientInformationMixed | undefined;
  let saved: OAuthTokens | undefined;
  let verifier = '';
  let authorizationUrl: URL | undefined;
  const provider: OAuthClientProvider = {
    redirectUrl: REDIRECT,
    clientMetadata: { client_name: 'Test Agent', redirect_uris: [REDIRECT], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' },
    clientInformation: () => info,
    saveClientInformation: (i) => void (info = i),
    tokens: () => saved,
    saveTokens: (t) => void (saved = t),
    redirectToAuthorization: (url) => void (authorizationUrl = url),
    saveCodeVerifier: (v) => void (verifier = v),
    codeVerifier: () => verifier,
  };

  const first = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider });
  await assert.rejects(new Client({ name: 'sdk', version: '1' }).connect(first), UnauthorizedError);
  assert.ok(info?.client_id, 'registered dynamically');
  assert.equal(authorizationUrl?.searchParams.get('resource'), `${base}/mcp`);

  const consentPath = (await fetch(authorizationUrl!, { redirect: 'manual' })).headers.get('location')!;
  const approved = await fetch(`${base}${consentPath}`, form({ decision: 'approve', ceiling_tier: '4' }, { cookie }));
  await first.finishAuth(new URL(approved.headers.get('location')!).searchParams.get('code')!);
  assert.match(saved?.access_token ?? '', /^cpa_/);

  const client = new Client({ name: 'sdk', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { authProvider: provider }));
  assert.match((await whoami(client)).write_ceiling, /Raw/);
});

test('personal tokens keep working when OAuth is on', async () => {
  assert.equal((await whoami(await connect(env.adminToken))).token, 'human');
});
