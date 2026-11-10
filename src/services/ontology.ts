import { z } from 'zod';
import type { Db, Queryable } from '../db.js';
import { forbidden, invalid } from '../errors.js';
import type { Actor, EntityTypeRow, RelationTypeRow, Tier, TierRank } from '../types.js';
import { audit } from './audit.js';
import { parse, tierSchema } from './knowledge.js';

const keySchema = z.string().regex(/^[a-z][a-z0-9_]*$/, 'lowercase letters, digits and underscores, starting with a letter');

export const propertyDefSchema = z
  .object({
    key: keySchema,
    type: z.enum(['string', 'number', 'boolean', 'date', 'url', 'enum']),
    required: z.boolean().optional(),
    options: z.array(z.string()).optional().describe('Allowed values when type is enum'),
    description: z.string().optional(),
  })
  .strict()
  .refine((p) => p.type !== 'enum' || (p.options && p.options.length > 0), 'enum properties need options');

export const entityTypeInput = z
  .object({
    key: keySchema,
    name: z.string().min(1),
    description: z.string().default(''),
    default_tier: tierSchema.default(3),
    domain: z.string().optional().describe('Domain key that owns this type'),
    properties: z.array(propertyDefSchema).default([]),
  })
  .strict();

export const relationTypeInput = z
  .object({
    key: keySchema,
    name: z.string().min(1).describe('Reads left to right, e.g. "works at"'),
    inverse_name: z.string().optional().describe('Reads right to left, e.g. "employs"'),
    description: z.string().default(''),
    from_types: z.array(keySchema).optional().describe('Entity types allowed as the source; omit for any'),
    to_types: z.array(keySchema).optional().describe('Entity types allowed as the target; omit for any'),
  })
  .strict();

export const domainInput = z
  .object({
    key: keySchema,
    name: z.string().min(1),
    description: z.string().default(''),
    owner_email: z.string().email(),
  })
  .strict();

export interface DomainRow {
  id: string;
  key: string;
  name: string;
  description: string;
  owner_id: string;
  owner_name: string;
  curators: { id: string; name: string; email: string }[];
}

export interface Ontology {
  tiers: Tier[];
  domains: DomainRow[];
  entity_types: (EntityTypeRow & { domain_key: string | null })[];
  relation_types: RelationTypeRow[];
}

/** The ontology is Canon: admins change it, and domain owners can manage types in their own domain. */
function requireHuman(actor: Actor) {
  if (actor.tokenKind !== 'human') throw forbidden('Agents cannot change the ontology', 'Ask a person with an admin or domain-owner role.');
}

export async function getOntology(db: Queryable): Promise<Ontology> {
  const [tiers, domains, types, rels] = await Promise.all([
    db.query<Tier>('select * from tiers order by rank'),
    db.query<DomainRow>(
      `select d.*, u.name as owner_name,
         coalesce((select json_agg(json_build_object('id', cu.id, 'name', cu.name, 'email', cu.email) order by cu.name)
                   from domain_curators dc join users cu on cu.id = dc.user_id where dc.domain_id = d.id), '[]') as curators
       from domains d join users u on u.id = d.owner_id order by d.name`,
    ),
    db.query<EntityTypeRow & { domain_key: string | null }>(
      'select et.*, d.key as domain_key from entity_types et left join domains d on d.id = et.domain_id order by et.key',
    ),
    db.query<RelationTypeRow>('select * from relation_types order by key'),
  ]);
  return { tiers: tiers.rows, domains: domains.rows, entity_types: types.rows, relation_types: rels.rows };
}

async function domainId(db: Queryable, key: string | undefined): Promise<string | null> {
  if (!key) return null;
  const { rows } = await db.query<{ id: string }>('select id from domains where key = $1', [key]);
  if (!rows[0]) throw invalid(`Unknown domain "${key}"`);
  return rows[0].id;
}

export async function defineEntityType(db: Db, actor: Actor, raw: unknown): Promise<EntityTypeRow> {
  requireHuman(actor);
  const input = parse(entityTypeInput, raw, 'entity type');
  const newDomain = await domainId(db, input.domain);
  const existing = await db.query<EntityTypeRow>('select * from entity_types where key = $1', [input.key]);
  const governingDomains = [newDomain, existing.rows[0]?.domain_id ?? null];
  const ownsDomains = newDomain !== null && governingDomains.every((d) => d === null || actor.ownedDomainIds.has(d));
  const allowed = actor.role === 'admin' || ownsDomains;
  if (!allowed) throw forbidden('Only admins, or the owner of the domain, can define entity types');

  const { rows } = await db.query<EntityTypeRow>(
    `insert into entity_types (key, name, description, default_tier, domain_id, properties)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (key) do update set name = excluded.name, description = excluded.description,
       default_tier = excluded.default_tier, domain_id = excluded.domain_id, properties = excluded.properties
     returning *`,
    [input.key, input.name, input.description, input.default_tier as TierRank, newDomain, JSON.stringify(input.properties)],
  );
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: existing.rows[0] ? 'ontology.type.update' : 'ontology.type.create', targetKind: 'ontology', targetId: input.key, before: existing.rows[0], after: rows[0] });
  return rows[0];
}

export async function defineRelationType(db: Db, actor: Actor, raw: unknown): Promise<RelationTypeRow> {
  requireHuman(actor);
  if (actor.role !== 'admin') throw forbidden('Only admins can define relation types');
  const input = parse(relationTypeInput, raw, 'relation type');
  const known = new Set((await db.query<{ key: string }>('select key from entity_types')).rows.map((r) => r.key));
  for (const t of [...(input.from_types ?? []), ...(input.to_types ?? [])]) {
    if (!known.has(t)) throw invalid(`Unknown entity type "${t}"`);
  }
  const { rows } = await db.query<RelationTypeRow>(
    `insert into relation_types (key, name, inverse_name, description, from_types, to_types)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (key) do update set name = excluded.name, inverse_name = excluded.inverse_name,
       description = excluded.description, from_types = excluded.from_types, to_types = excluded.to_types
     returning *`,
    [input.key, input.name, input.inverse_name ?? null, input.description, input.from_types ?? null, input.to_types ?? null],
  );
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'ontology.relation.define', targetKind: 'ontology', targetId: input.key, after: rows[0] });
  return rows[0];
}

export async function createDomain(db: Db, actor: Actor, raw: unknown) {
  requireHuman(actor);
  if (actor.role !== 'admin') throw forbidden('Only admins can create domains');
  const input = parse(domainInput, raw, 'domain');
  const owner = await db.query<{ id: string }>('select id from users where email = $1', [input.owner_email]);
  if (!owner.rows[0]) throw invalid(`No user with email ${input.owner_email}`);
  const { rows } = await db.query(
    `insert into domains (key, name, description, owner_id) values ($1, $2, $3, $4) returning *`,
    [input.key, input.name, input.description, owner.rows[0].id],
  );
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'ontology.domain.create', targetKind: 'ontology', targetId: input.key, after: rows[0] });
  return rows[0];
}

export async function setCurator(db: Db, actor: Actor, domainKey: string, email: string, add: boolean): Promise<void> {
  requireHuman(actor);
  const domain = await db.query<{ id: string; owner_id: string }>('select id, owner_id from domains where key = $1', [domainKey]);
  if (!domain.rows[0]) throw invalid(`Unknown domain "${domainKey}"`);
  if (actor.role !== 'admin' && domain.rows[0].owner_id !== actor.userId) throw forbidden('Only admins and the domain owner can manage curators');
  const user = await db.query<{ id: string }>('select id from users where email = $1', [email]);
  if (!user.rows[0]) throw invalid(`No user with email ${email}`);
  if (add) {
    await db.query('insert into domain_curators (domain_id, user_id) values ($1, $2) on conflict do nothing', [domain.rows[0].id, user.rows[0].id]);
  } else {
    await db.query('delete from domain_curators where domain_id = $1 and user_id = $2', [domain.rows[0].id, user.rows[0].id]);
  }
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: add ? 'ontology.curator.add' : 'ontology.curator.remove', targetKind: 'ontology', targetId: domainKey, after: { email } });
}
