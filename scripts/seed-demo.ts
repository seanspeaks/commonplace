// Fills an empty instance with a small, realistic graph so a demo or workshop starts with something to curate.
// Usage: DATABASE_URL=... ADMIN_EMAIL=... ADMIN_TOKEN=... npm run seed:demo
import { actorFromToken, generateToken, hashToken, tokenPrefix } from '../src/auth.js';
import { bootstrap } from '../src/bootstrap.js';
import { config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrator.js';
import { Knowledge } from '../src/services/knowledge.js';
import { createDomain, setCurator } from '../src/services/ontology.js';
import type { TierRank } from '../src/types.js';

const db = createPool(config.databaseUrl);
await migrate(db);
await bootstrap(db, config);
if (!config.adminToken) throw new Error('Set ADMIN_TOKEN');
const admin = await actorFromToken(db, config.adminToken);
if (!admin) throw new Error('ADMIN_TOKEN does not match a user');
const k = await Knowledge.create(db, config.publicUrl);

async function person(email: string, name: string) {
  const { rows } = await db.query<{ id: string }>(
    `insert into users (email, name) values ($1, $2) on conflict (email) do update set name = excluded.name returning id`,
    [email, name],
  );
  return rows[0].id;
}
async function token(userId: string, kind: 'human' | 'agent', ceiling: TierRank, name: string) {
  const raw = generateToken();
  await db.query(`insert into api_tokens (user_id, name, kind, ceiling_tier, token_hash, prefix) values ($1, $2, $3, $4, $5, $6)`, [
    userId,
    name,
    kind,
    ceiling,
    hashToken(raw),
    tokenPrefix(raw),
  ]);
  return { raw, actor: (await actorFromToken(db, raw))! };
}

const mayaId = await person('maya@example.com', 'Maya Chen');
const leoId = await person('leo@example.com', 'Leo Park');
await createDomain(db, admin, { key: 'clients', name: 'Clients', description: 'Who we work with and what we promised them.', owner_email: admin.email });
await setCurator(db, admin, 'clients', 'maya@example.com', true);

const maya = await token(mayaId, 'human', 1, 'Demo sign-in');
const leo = await token(leoId, 'human', 1, 'Demo sign-in');
const leoAgent = await token(leoId, 'agent', 4, "Leo's Claude Code");

const call = { kind: 'meeting', ref: 'kickoff-call', note: 'Kickoff with Northwind' };
const northwind = await k.createEntity(admin, {
  type: 'organization',
  name: 'Northwind Health',
  summary: 'Regional healthcare network. Our largest client.',
  properties: { relationship: 'client', website: 'https://northwind.example' },
  tier: 2,
  domain: 'clients',
  owner_email: 'maya@example.com',
});
const portal = await k.createEntity(maya.actor, {
  type: 'project',
  name: 'Patient Portal Sync',
  summary: "Two-way sync between Northwind's EHR and their patient portal.",
  properties: { status: 'active', started_on: '2026-09-15' },
});
const sla = await k.createEntity(admin, { type: 'policy', name: 'Client SLA', summary: 'P1 issues get a response within 1 business hour.' });
const choice = await k.createEntity(admin, {
  type: 'decision',
  name: 'Webhooks over polling for Northwind',
  summary: "Use the EHR's webhooks; poll nightly only as a backfill.",
  properties: { decided_on: '2026-10-02', status: 'decided' },
});
await k.createEntity(maya.actor, { type: 'person', name: 'Maya Chen', properties: { email: 'maya@example.com', title: 'Delivery lead' } });
await k.createEntity(leo.actor, { type: 'person', name: 'Leo Park', properties: { email: 'leo@example.com', title: 'Engineer' } });
const dana = await k.createEntity(maya.actor, { type: 'person', name: 'Dana Ortiz', summary: "Northwind's VP of Digital. Our champion.", properties: { title: 'VP Digital' } });

await k.perform(maya.actor, portal.id, 'add_relation', { type: 'part_of', to: northwind.id });
await k.perform(maya.actor, dana.id, 'add_relation', { type: 'works_at', to: northwind.id });
await k.perform(maya.actor, 'person:Maya Chen', 'add_relation', { type: 'responsible_for', to: portal.id });
await k.perform(leo.actor, 'person:Leo Park', 'add_relation', { type: 'works_on', to: portal.id });
await k.perform(admin, choice.id, 'add_relation', { type: 'about', to: portal.id });
await k.perform(admin, sla.id, 'add_relation', { type: 'about', to: northwind.id });

await k.perform(maya.actor, northwind.id, 'add_observation', { content: 'Contract renews every January. Renewal owner is Maya.', tier: 2 });
await k.perform(maya.actor, portal.id, 'add_observation', { content: 'Go-live target is Dec 15.' });
await k.perform(leoAgent.actor, portal.id, 'add_observation', { content: 'EHR sandbox rate limit is 10 requests/second.' }, { kind: 'doc', url: 'https://northwind.example/api-docs' });
await k.perform(leoAgent.actor, northwind.id, 'add_observation', { content: 'Dana mentioned a second region coming online in Q2.' }, call);

await k.requestUpdate(leoAgent.actor, {
  entity: northwind.id,
  action: 'add_observation',
  payload: { content: 'Northwind is expanding to a second region in Q2 2027; expect a scope change.' },
  rationale: 'Dana said this on the kickoff call. Worth making Verified so sales sees it.',
  source: call,
});
await k.requestUpdate(leo.actor, {
  entity: sla.id,
  action: 'update_entity',
  payload: { summary: 'P1 issues get a response within 1 business hour, 24/7 for Northwind.' },
  rationale: "Northwind's contract has a 24/7 rider.",
});

console.log(`
Demo data ready.
  Admin (${admin.email}):  sign in with ADMIN_TOKEN
  Maya Chen (curator):     ${maya.raw}
  Leo Park (member):       ${leo.raw}
  Leo's agent (MCP only):  ${leoAgent.raw}
`);
await db.end();
