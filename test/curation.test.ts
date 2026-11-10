import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { AppError } from '../src/errors.js';
import { listNotifications } from '../src/services/notify.js';
import { setCurator } from '../src/services/ontology.js';
import { setup, type TestEnv } from './helpers.js';

let env: TestEnv;
before(async () => {
  env = await setup();
});
after(async () => {
  await env.close();
});

const src = { kind: 'meeting', ref: 'call-42' };

async function rejects(p: Promise<unknown>, code: AppError['code'], pattern?: RegExp) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${err}`);
    assert.equal(err.code, code, err.message);
    if (pattern) assert.match(err.message + (err.hint ?? ''), pattern);
    return true;
  });
}

test('a member asks to change Canon; the owner is pinged, approves, and the requester gets credit', async () => {
  const { k, admin } = env;
  const policy = await k.createEntity(admin, { type: 'policy', name: 'Refund policy', summary: 'Refunds within 30 days.' });
  assert.equal(policy.tier, 1);

  const bob = await env.addUser('bob@example.com');
  await rejects(k.perform(bob.actor, policy.id, 'update_entity', { summary: 'Refunds within 60 days.' }), 'forbidden', /request_update/);

  const req = await k.requestUpdate(bob.actor, {
    entity: 'policy:Refund policy',
    action: 'update_entity',
    payload: { summary: 'Refunds within 60 days.' },
    rationale: 'We changed this in the Q3 pricing review.',
  });
  assert.equal(req.assignee_id, admin.userId);
  const adminInbox = await listNotifications(env.db, admin.userId, { unreadOnly: true });
  assert.ok(adminInbox.some((n) => n.kind === 'request.created' && n.change_request_id === req.id));

  const { request } = await k.curate(admin, { request_id: req.id, decision: 'approve', note: 'Thanks' });
  assert.equal(request.status, 'approved');
  const after = await k.getEntity(policy.id);
  assert.equal(after.entity.summary, 'Refunds within 60 days.');
  assert.equal(after.entity.updated_by, bob.id);
  assert.equal(after.entity.version, 2);

  const bobInbox = await listNotifications(env.db, bob.id, { unreadOnly: true });
  assert.ok(bobInbox.some((n) => n.kind === 'request.resolved' && /approved/.test(n.title)));
});

test('an agent can drop Raw facts anywhere but must request anything above its ceiling, even on its own user\'s knowledge', async () => {
  const { k } = env;
  const carol = await env.addUser('carol@example.com');
  const agent = await env.addToken(carol.id, 'agent', 4);
  const acme = await k.createEntity(carol.actor, { type: 'organization', name: 'Acme', properties: { relationship: 'client' } });
  assert.equal(acme.tier, 3);

  await rejects(k.perform(agent.actor, acme.id, 'add_observation', { content: 'Acme renewed for 2027.' }), 'invalid', /cite a source/);

  const raw = await k.perform(agent.actor, acme.id, 'add_observation', { content: 'Acme renewed for 2027.' }, src);
  assert.equal((raw.observation as { tier: number }).tier, 4);

  await rejects(k.perform(agent.actor, acme.id, 'update_entity', { summary: 'Our biggest client' }, src), 'forbidden', /ceiling|Raw/);

  const req = await k.requestUpdate(agent.actor, { entity: acme.id, action: 'update_entity', payload: { summary: 'Our biggest client' }, rationale: 'From the renewal call', source: src });
  assert.equal(req.assignee_id, carol.id, 'routes to the owner, who is the agent\'s own user');

  await rejects(k.curate(agent.actor, { request_id: req.id, decision: 'approve' }), 'forbidden');
  await k.curate(carol.actor, { request_id: req.id, decision: 'approve' });
  assert.equal((await k.getEntity(acme.id)).entity.summary, 'Our biggest client');
});

test('promotion into Verified routes to the domain owner when the entity owner cannot approve it', async () => {
  const { k, admin } = env;
  const dave = await env.addUser('dave@example.com');
  const project = await k.createEntity(dave.actor, { type: 'project', name: 'Atlas' });
  assert.equal(project.tier, 3);

  await rejects(k.perform(dave.actor, project.id, 'set_tier', { tier: 2 }), 'forbidden', /curator/);

  const req = await k.requestUpdate(dave.actor, { entity: project.id, action: 'set_tier', payload: { tier: 2 }, rationale: 'Confirmed with the client' });
  assert.equal(req.assignee_id, admin.userId, 'general domain is owned by the admin');
  const daveInbox = await listNotifications(env.db, dave.id, { unreadOnly: true });
  assert.ok(daveInbox.some((n) => n.title.startsWith('FYI')), 'the entity owner still hears about it');

  await k.curate(admin, { request_id: req.id, decision: 'approve' });
  assert.equal((await k.getEntity(project.id)).entity.tier, 2);

  // Now Verified: dave still owns it and can overwrite it; another member cannot until made a curator.
  await k.perform(dave.actor, project.id, 'update_entity', { summary: 'Data platform rebuild' });
  const erin = await env.addUser('erin@example.com');
  await rejects(k.perform(erin.actor, project.id, 'update_entity', { summary: 'nope' }), 'forbidden', /curators/);
  await setCurator(env.db, admin, 'general', 'erin@example.com', true);
  const erinCurator = await env.refresh(erin.token);
  await k.perform(erinCurator, project.id, 'update_entity', { summary: 'Data platform rebuild (phase 1)' });

  const daveNotes = await listNotifications(env.db, dave.id, { unreadOnly: true });
  assert.ok(daveNotes.some((n) => n.kind === 'entity.changed'), 'owner gets an FYI when someone else edits their knowledge');
});

test('owners cannot self-promote to Canon; a fact cannot outrank its entity', async () => {
  const { k } = env;
  const frank = await env.addUser('frank@example.com');
  const topic = await k.createEntity(frank.actor, { type: 'topic', name: 'Pricing' });
  await rejects(k.perform(frank.actor, topic.id, 'set_tier', { tier: 1 }), 'forbidden');
  await rejects(k.perform(frank.actor, topic.id, 'add_observation', { content: 'x', tier: 2 }), 'invalid', /more trusted than its entity/);
  await rejects(k.createEntity(frank.actor, { type: 'topic', name: 'Secret canon', tier: 1 }), 'forbidden');

  const policy = await k.createEntity(frank.actor, { type: 'policy', name: 'Expense policy' });
  assert.equal(policy.tier, 3, 'stepped down from the type default (Canon) to what frank may create');
});

test('approve with edits, stale warnings, and owners can always reject', async () => {
  const { k, admin } = env;
  const gina = await env.addUser('gina@example.com');
  const decision = await k.createEntity(admin, { type: 'decision', name: 'Use Postgres' });
  assert.equal(decision.tier, 2);

  const r1 = await k.requestUpdate(gina.actor, { entity: decision.id, action: 'add_observation', payload: { content: 'We chose Postgres for pgvector.' }, rationale: 'From the arch review' });
  assert.equal((r1.payload as { tier: number }).tier, 2, 'requested facts default to the entity tier');

  await k.perform(admin, decision.id, 'update_entity', { summary: 'Postgres for everything' });
  const approved = await k.curate(admin, { request_id: r1.id, decision: 'approve', edits: { content: 'We chose Postgres for pgvector and simplicity.' } });
  assert.equal(approved.stale, true);
  const facts = (await k.getEntity(decision.id)).observations.map((o) => o.content);
  assert.ok(facts.includes('We chose Postgres for pgvector and simplicity.'));

  const r2 = await k.requestUpdate(gina.actor, { entity: decision.id, action: 'add_relation', payload: { type: 'related_to', to: 'project:Atlas' }, rationale: 'related' });
  const rejected = await k.curate(admin, { request_id: r2.id, decision: 'reject', note: 'Not related' });
  assert.equal(rejected.request.status, 'rejected');
  await rejects(k.curate(admin, { request_id: r2.id, decision: 'approve' }), 'conflict');

  const r3 = await k.requestUpdate(gina.actor, { entity: decision.id, action: 'deprecate_entity', payload: {}, rationale: 'old' });
  await k.withdraw(gina.actor, r3.id);
  assert.equal((await k.getRequest(r3.id)).status, 'withdrawn');
});

test('ontology is enforced: unknown properties, bad enums, and relation type constraints', async () => {
  const { k, admin } = env;
  await rejects(k.createEntity(admin, { type: 'organization', name: 'Bad Co', properties: { color: 'red' } }), 'invalid', /Unknown property/);
  await rejects(k.createEntity(admin, { type: 'organization', name: 'Bad Co', properties: { relationship: 'frenemy' } }), 'invalid', /one of/);
  const ada = await k.createEntity(admin, { type: 'person', name: 'Ada' });
  await rejects(k.perform(admin, ada.id, 'add_relation', { type: 'works_at', to: 'topic:Pricing' }), 'invalid', /can't point to a topic/);
  await k.perform(admin, ada.id, 'add_relation', { type: 'works_at', to: 'organization:Acme' });
  await rejects(k.perform(admin, ada.id, 'add_relation', { type: 'works_at', to: 'Acme' }), 'conflict');

  const graph = await k.neighbors('organization:Acme', { depth: 1 });
  assert.ok(graph.nodes.some((n) => n.name === 'Ada'));
});

test('search finds entities by name, alias, and fact text', async () => {
  const { k } = env;
  assert.ok((await k.search('acme')).some((e) => e.name === 'Acme'));
  assert.ok((await k.search('renewed 2027')).some((e) => e.name === 'Acme' && e.matched_fact?.includes('renewed')));
  assert.ok((await k.search('refund', { maxTier: 1 })).some((e) => e.name === 'Refund policy'));
  assert.equal((await k.search('refund', { maxTier: 1 })).some((e) => e.tier > 1), false);
});
