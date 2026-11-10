import type { Db } from './db.js';
import { hashToken, tokenPrefix } from './auth.js';
import type { PropertyDef, TierRank } from './types.js';

interface StarterType {
  key: string;
  name: string;
  description: string;
  default_tier: TierRank;
  properties: PropertyDef[];
}

const starterTypes: StarterType[] = [
  {
    key: 'person',
    name: 'Person',
    description: 'Someone on the team or someone we work with.',
    default_tier: 3,
    properties: [
      { key: 'email', type: 'string' },
      { key: 'title', type: 'string' },
    ],
  },
  {
    key: 'organization',
    name: 'Organization',
    description: 'A company, client, partner or vendor.',
    default_tier: 3,
    properties: [
      { key: 'website', type: 'url' },
      { key: 'relationship', type: 'enum', options: ['client', 'prospect', 'partner', 'vendor', 'internal'] },
    ],
  },
  {
    key: 'project',
    name: 'Project',
    description: 'A body of work with a goal.',
    default_tier: 3,
    properties: [
      { key: 'status', type: 'enum', options: ['planned', 'active', 'paused', 'done'] },
      { key: 'started_on', type: 'date' },
    ],
  },
  {
    key: 'decision',
    name: 'Decision',
    description: 'Something we decided, and why.',
    default_tier: 2,
    properties: [
      { key: 'decided_on', type: 'date' },
      { key: 'status', type: 'enum', options: ['proposed', 'decided', 'superseded'] },
    ],
  },
  {
    key: 'policy',
    name: 'Policy',
    description: 'A rule we follow.',
    default_tier: 1,
    properties: [{ key: 'effective_on', type: 'date' }],
  },
  { key: 'topic', name: 'Topic', description: 'A concept, term or area of knowledge.', default_tier: 3, properties: [] },
  { key: 'document', name: 'Document', description: 'A doc, spec, recording or page that holds detail.', default_tier: 3, properties: [{ key: 'url', type: 'url' }] },
];

const starterRelations: { key: string; name: string; inverse_name: string; from: string[] | null; to: string[] | null }[] = [
  { key: 'works_at', name: 'works at', inverse_name: 'employs', from: ['person'], to: ['organization'] },
  { key: 'works_on', name: 'works on', inverse_name: 'has contributor', from: ['person'], to: ['project'] },
  { key: 'responsible_for', name: 'is responsible for', inverse_name: 'is the responsibility of', from: ['person'], to: null },
  { key: 'client_of', name: 'is a client of', inverse_name: 'has client', from: ['organization'], to: ['organization'] },
  { key: 'part_of', name: 'is part of', inverse_name: 'includes', from: null, to: null },
  { key: 'about', name: 'is about', inverse_name: 'is the subject of', from: ['decision', 'document', 'policy'], to: null },
  { key: 'supersedes', name: 'supersedes', inverse_name: 'is superseded by', from: ['decision', 'policy', 'document'], to: ['decision', 'policy', 'document'] },
  { key: 'documented_in', name: 'is documented in', inverse_name: 'documents', from: null, to: ['document'] },
  { key: 'related_to', name: 'is related to', inverse_name: 'is related to', from: null, to: null },
];

/**
 * First boot: create the admin from ADMIN_EMAIL / ADMIN_TOKEN, a "general" domain they own,
 * and a small starter ontology. Safe to run on every deploy.
 */
export async function bootstrap(db: Db, cfg: { adminEmail?: string; adminToken?: string }): Promise<void> {
  const users = await db.query<{ count: string }>('select count(*) from users');
  if (users.rows[0].count !== '0') return;
  if (!cfg.adminEmail || !cfg.adminToken) {
    console.warn('No users yet. Set ADMIN_EMAIL and ADMIN_TOKEN to create the first admin.');
    return;
  }

  const client = await db.connect();
  try {
    await client.query('begin');
    const name = cfg.adminEmail.split('@')[0];
    const admin = await client.query<{ id: string }>(`insert into users (email, name, role) values ($1, $2, 'admin') returning id`, [cfg.adminEmail, name]);
    const adminId = admin.rows[0].id;
    await client.query(
      `insert into api_tokens (user_id, name, kind, ceiling_tier, token_hash, prefix) values ($1, 'ADMIN_TOKEN', 'human', 1, $2, $3)`,
      [adminId, hashToken(cfg.adminToken), tokenPrefix(cfg.adminToken)],
    );
    const domain = await client.query<{ id: string }>(
      `insert into domains (key, name, description, owner_id) values ('general', 'General', 'Default domain for team-wide knowledge.', $1) returning id`,
      [adminId],
    );
    const typeCount = await client.query<{ count: string }>('select count(*) from entity_types');
    if (typeCount.rows[0].count === '0') {
      for (const t of starterTypes) {
        await client.query(`insert into entity_types (key, name, description, default_tier, domain_id, properties) values ($1, $2, $3, $4, $5, $6)`, [
          t.key,
          t.name,
          t.description,
          t.default_tier,
          domain.rows[0].id,
          JSON.stringify(t.properties),
        ]);
      }
      for (const r of starterRelations) {
        await client.query(`insert into relation_types (key, name, inverse_name, from_types, to_types) values ($1, $2, $3, $4, $5)`, [
          r.key,
          r.name,
          r.inverse_name,
          r.from,
          r.to,
        ]);
      }
    }
    await client.query('commit');
    console.log(`Created admin ${cfg.adminEmail}. Sign in with ADMIN_TOKEN.`);
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
