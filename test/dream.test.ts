import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { DREAM_EMAIL, runDream } from '../src/dream/run.js';
import { recall } from '../src/services/recall.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
let provider: Server;
let providerUrl: string;
const seen: { jsonMode: boolean }[] = [];

// Stands in for an OpenAI-compatible inference provider, the one external dependency these tests can't run for real.
// It rejects response_format on the first call, like some providers do, then answers from the facts it was sent.
before(async () => {
  env = await setup();
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body);
      seen.push({ jsonMode: Boolean(parsed.response_format) });
      if (seen.length === 1) {
        res.writeHead(400).end('{"error":"response_format is not supported"}');
        return;
      }
      const input = JSON.parse(parsed.messages[1].content) as { entity: { name: string; summary: string }; facts: { id: string; text: string }[] };
      const id = (start: string) => input.facts.find((f) => f.text.startsWith(start))?.id ?? 'missing';
      const answer =
        input.entity.name === 'Initech'
          ? {
              digest: [
                { text: 'Initech renewed through 2027 at 60k.', cites: [id('Renewed'), 'deadbeef'] },
                { text: 'They are unhappy with support.', cites: ['cafebabe'] },
              ],
              supersede: [{ old: id('Contract ends'), new: id('Renewed'), why: 'The renewal replaces the old end date.' }],
              contradictions: [{ facts: [id('Champion is Bill'), id('Champion is Peter')], why: 'Two different champions.' }],
              summary: { text: 'Client, renewed through 2027.', cites: [id('Renewed')] },
            }
          : { digest: [], supersede: [], contradictions: [], summary: null };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: `Here you go:\n${JSON.stringify(answer)}` } }], usage: { prompt_tokens: 100, completion_tokens: 50 } }));
    });
  });
  provider.listen(0);
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/v1`;
});

after(async () => {
  await new Promise((resolve) => provider.close(resolve));
  await env.close();
});

test('without an inference provider the dream still learns from recall and files findings, and says so', async () => {
  const sam = await env.addUser('sam@example.com');
  const globex = await env.k.createEntity(env.admin, { type: 'organization', name: 'Globex', summary: 'Prospect.' });
  await env.k.createEntity(env.admin, { type: 'organization', name: 'Globex Inc', summary: 'Same company, added twice.' });
  const hooli = await env.k.createEntity(env.admin, { type: 'organization', name: 'Hooli', summary: 'Prospect.' });

  // Sam is handed Globex and Hooli. Sam then writes to Globex, so Globex was useful and Hooli wasn't.
  await recall(env.k, sam.actor, { text: 'Globex and Hooli both asked about pricing', via: 'hook' });
  await env.k.perform(sam.actor, globex.id, 'add_observation', { content: 'Globex asked for a pricing call next week.', tier: 4 });

  const result = await runDream(env.db, { publicUrl: 'http://test.local', llm: null });
  assert.equal(result.status, 'done');
  assert.match(result.note, /Inference is off/);
  assert.equal(result.stats.findings.duplicate, 1);

  const signals = await env.db.query<{ entity_id: string; recalled: number; used: number; boost: number }>('select * from entity_signals');
  const byId = Object.fromEntries(signals.rows.map((s) => [s.entity_id, s]));
  assert.equal(byId[globex.id].used, 1);
  assert.ok(byId[globex.id].boost > 0, 'used after recall rises');
  assert.ok(byId[hooli.id].boost < 0, 'recalled and ignored sinks');

  const runs = await env.db.query('select status, inference, finished_at from dream_runs');
  assert.equal(runs.rowCount, 1);
  assert.equal(runs.rows[0].inference, 'off');
  assert.ok(runs.rows[0].finished_at);
});

test('with a provider the dream proposes through owners, keeps authority, and drops claims it cannot cite', async () => {
  const carol = await env.addUser('carol@example.com');
  const initech = await env.k.createEntity(carol.actor, { type: 'organization', name: 'Initech' });
  const add = (content: string, tier: 2 | 3 | 4) => env.k.perform(carol.actor, initech.id, 'add_observation', { content, tier });
  const old = (await add('Contract ends December 2026.', 3)).observation as { id: string };
  await add('Renewed through 2027 at 60k.', 4);
  await add('Champion is Bill.', 3);
  await add('Champion is Peter.', 4);
  await env.db.query(`update observations set created_at = now() - interval '200 days' where id = $1`, [old.id]);

  const llm = { baseUrl: providerUrl, model: 'test-model', apiKey: 'k' };
  const result = await runDream(env.db, { publicUrl: 'http://test.local', llm });
  assert.equal(result.status, 'done', result.note);
  assert.deepEqual(
    seen.map((s) => s.jsonMode),
    [true, false, ...seen.slice(2).map(() => false)],
    'falls back to prompt-only JSON after a 400',
  );
  assert.equal(result.stats.briefs, 1);
  assert.equal(result.stats.requests, 2);
  assert.equal(result.stats.dropped_citations, 2);
  assert.equal(result.stats.findings.contradiction, 1);
  assert.ok(result.stats.llm && result.stats.llm.tokens_in > 0);

  const brief = await env.db.query<{ brief: string; authority_tier: number }>('select brief, authority_tier from entity_briefs where entity_id = $1', [initech.id]);
  assert.equal(brief.rows[0].brief, 'Initech renewed through 2027 at 60k.', 'the uncited sentence is gone');
  assert.equal(brief.rows[0].authority_tier, 4, 'resting on a Raw fact makes the digest Raw');

  const requests = await env.db.query<{ action: string; assignee: string; requester: string }>(
    `select c.action, a.email as assignee, r.email as requester from change_requests c join users a on a.id = c.assignee_id join users r on r.id = c.requested_by
     where c.entity_id = $1 order by c.action`,
    [initech.id],
  );
  assert.deepEqual(requests.rows, [
    { action: 'retract_observation', assignee: 'carol@example.com', requester: DREAM_EMAIL },
    { action: 'update_entity', assignee: 'carol@example.com', requester: DREAM_EMAIL },
  ]);
  const stillThere = await env.db.query('select status from observations where id = $1', [old.id]);
  assert.equal(stillThere.rows[0].status, 'active', 'proposals are never applied by the dream');

  const recalled = await recall(env.k, carol.actor, { text: 'Where are we with the Initech renewal?', via: 'tool' });
  assert.match(recalled.text, /Nightly digest, unreviewed, no more trusted than Raw: Initech renewed/);

  await add('Renewed contract signed by procurement.', 4);
  const again = await runDream(env.db, { publicUrl: 'http://test.local', llm });
  assert.equal(again.stats.requests, 0, 'an open proposal is not filed twice');
  assert.equal((await env.db.query('select 1 from dream_runs')).rowCount, 3, 'one ledger row per run');
});

test('the Dream page shows last night, its findings and the ledger', async () => {
  const { app } = await createApp(env.db, { publicUrl: 'http://test.local' });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const login = await fetch(`${base}/login`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: base },
      body: new URLSearchParams({ token: env.adminToken }),
    });
    const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
    const page = await (await fetch(`${base}/dream`, { headers: { cookie } })).text();
    assert.match(page, /Last night/);
    assert.match(page, /inference on \(test-model\)/);
    assert.match(page, /Facts that disagree/);
    assert.match(page, /Champion is Bill/);
    assert.match(page, /Possible duplicates/);
    assert.match(page, /Ledger/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
