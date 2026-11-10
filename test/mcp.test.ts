import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp } from '../src/app.js';
import { deliverPending } from '../src/services/notify.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let server: Server;
let base: string;

before(async () => {
  env = await setup();
  const { app } = await createApp(env.db, { publicUrl: 'http://test.local' });
  server = app.listen(0);
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await env.close();
});

async function connect(token: string): Promise<Client> {
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = (await client.callTool({ name, arguments: args })) as { content: { text: string }[]; isError?: boolean };
  return { error: Boolean(result.isError), data: JSON.parse(result.content[0].text) };
}

test('rejects requests without a valid token', async () => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 401);
  assert.match(res.headers.get('www-authenticate') ?? '', /Bearer/);
});

test('an agent hits the ceiling, files request_update, and the owner curates over MCP', async () => {
  const owner = await connect(env.adminToken);
  const tools = (await owner.listTools()).tools.map((t) => t.name);
  for (const name of ['search_knowledge', 'get_entity', 'request_update', 'curate_knowledge', 'inbox', 'get_ontology']) assert.ok(tools.includes(name), name);

  const created = await call(owner, 'create_entity', { type: 'organization', name: 'Globex', summary: 'Prospect', properties: { relationship: 'prospect' }, tier: 2 });
  assert.equal(created.error, false, JSON.stringify(created.data));

  const sam = await env.addUser('sam@example.com');
  const agentToken = (await env.addToken(sam.id, 'agent', 4)).token;
  const agent = await connect(agentToken);

  const who = await call(agent, 'whoami');
  assert.match(who.data.write_ceiling, /Raw/);

  const fact = await call(agent, 'add_observation', { entity: 'organization:Globex', content: 'Globex signed an MSA on Nov 3.', source: { kind: 'email', ref: 'thread-9' } });
  assert.equal(fact.error, false, JSON.stringify(fact.data));
  assert.match(fact.data.done, /Raw fact/);

  const denied = await call(agent, 'update_entity', { entity: 'Globex', changes: { properties: { relationship: 'client' } }, source: { kind: 'email', ref: 'thread-9' } });
  assert.equal(denied.error, true);
  assert.equal(denied.data.error, 'forbidden');
  assert.equal(denied.data.suggested_request_update.action, 'update_entity');

  const req = await call(agent, 'request_update', {
    entity: 'Globex',
    action: 'update_entity',
    payload: { properties: { relationship: 'client' } },
    rationale: 'They signed the MSA, see thread-9.',
    source: { kind: 'email', ref: 'thread-9' },
  });
  assert.equal(req.error, false, JSON.stringify(req.data));
  assert.equal(req.data.assigned_to, 'admin');

  const inbox = await call(owner, 'inbox', { mark_read: true });
  assert.ok(inbox.data.notifications.some((n: { request_id: string }) => n.request_id === req.data.request_id));

  const queue = await call(owner, 'list_requests', { box: 'assigned' });
  const item = queue.data.find((q: { request_id: string }) => q.request_id === req.data.request_id);
  assert.match(item.requested_by, /agent/);

  const curated = await call(owner, 'curate_knowledge', { request_id: req.data.request_id, decision: 'approve', note: 'Confirmed' });
  assert.equal(curated.data.status, 'approved');

  const entity = await call(agent, 'get_entity', { entity: 'Globex' });
  assert.equal(entity.data.properties.relationship, 'client');
  assert.ok(entity.data.facts.some((f: { content: string; by: string }) => f.content.includes('MSA') && f.by.includes('(agent)')));

  const mine = await call(agent, 'list_requests', { box: 'mine', status: 'any' });
  assert.equal(mine.data[0].status, 'approved');

  const ontologyChange = await call(agent, 'define_relation_type', { key: 'competes_with', name: 'competes with' });
  assert.equal(ontologyChange.error, true);
});

test('owner pings go out to a Slack-style webhook', async () => {
  const received: { text: string; kind: string }[] = [];
  const hook = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('ok');
    });
  }).listen(0);
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  try {
    await env.db.query('update notifications set delivered_at = now()');
    await env.db.query('update users set notify_webhook_url = $1 where email = $2', [hookUrl, 'admin@example.com']);
    const tia = await env.addUser('tia@example.com');
    await env.k.requestUpdate(tia.actor, { entity: 'Globex', action: 'add_observation', payload: { content: 'Globex HQ moved to Austin.' }, rationale: 'Saw it on LinkedIn' });
    const delivered = await deliverPending(env.db, undefined);
    assert.equal(delivered, 1);
    assert.equal(received[0].kind, 'request.created');
    assert.match(received[0].text, /tia requests a change to Globex/);
  } finally {
    hook.close();
  }
});

test('the UI signs in with a token and falls back to a request when an edit is not allowed', async () => {
  const uma = await env.addUser('uma@example.com');
  const headers = { origin: base, 'content-type': 'application/x-www-form-urlencoded' };

  const crossSite = await fetch(`${base}/login`, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: `token=${uma.token}`, redirect: 'manual' });
  assert.equal(crossSite.status, 403);

  const login = await fetch(`${base}/login`, { method: 'POST', headers, body: `token=${encodeURIComponent(uma.token)}`, redirect: 'manual' });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];

  const home = await fetch(`${base}/`, { headers: { cookie } });
  assert.match(await home.text(), /Waiting on you/);

  const globex = (await env.k.resolveEntity(env.db, 'Globex')).id;
  const pageHtml = await (await fetch(`${base}/e/${globex}`, { headers: { cookie } })).text();
  assert.match(pageHtml, /Suggest an edit/, 'Verified entity owned by someone else');

  const attempt = await fetch(`${base}/e/${globex}/act`, { method: 'POST', headers: { ...headers, cookie }, body: 'action=set_tier&tier=1', redirect: 'manual' });
  const fallback = await attempt.text();
  assert.equal(attempt.status, 200);
  assert.match(fallback, /Ask admin to make this change/);

  const send = await fetch(`${base}/e/${globex}/act`, {
    method: 'POST',
    headers: { ...headers, cookie },
    body: new URLSearchParams({ action: 'set_tier', mode: 'request', payload_json: JSON.stringify({ tier: 1 }), rationale: 'Globex is now a key account' }).toString(),
    redirect: 'manual',
  });
  assert.equal(send.status, 303);
  assert.match(send.headers.get('location') ?? '', /^\/requests\//);
  const requestPage = await (await fetch(`${base}${send.headers.get('location')}`, { headers: { cookie } })).text();
  assert.match(requestPage, /Promote Globex from Verified to Canon/);
});
