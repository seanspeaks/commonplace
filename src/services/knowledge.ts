import { z } from 'zod';
import { withTx, type Db, type Queryable, type Tx } from '../db.js';
import { AppError, conflict, forbidden, invalid, notFound } from '../errors.js';
import { canWrite, defaultFactTier, type WriteTarget } from '../policy.js';
import type {
  ActionKey,
  Actor,
  ChangeRequestRow,
  EntityRow,
  EntityTypeRow,
  ObservationRow,
  PropertyDef,
  RelationRow,
  RelationTypeRow,
  Source,
  Tier,
  TierRank,
} from '../types.js';
import { humanActorFor } from '../auth.js';
import { audit } from './audit.js';
import { notify } from './notify.js';

const NOBODY = '00000000-0000-0000-0000-000000000000';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const tierSchema = z.number().int().min(1).max(4).transform((n) => n as TierRank);
export const sourceSchema = z
  .object({
    kind: z.string().max(100).optional().describe('e.g. "meeting", "email", "doc", "url", "conversation"'),
    ref: z.string().max(500).optional().describe('An identifier in the source system, e.g. a call id or ticket number'),
    url: z.string().url().optional(),
    note: z.string().max(2000).optional(),
  })
  .strict();

const propertiesSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));

export const actionSchemas = {
  update_entity: z
    .object({
      name: z.string().min(1).max(300).optional(),
      summary: z.string().max(10_000).optional(),
      aliases: z.array(z.string().min(1).max(300)).max(50).optional(),
      properties: propertiesSchema.optional().describe('Merged into existing properties. Set a key to null to remove it.'),
      domain: z.string().optional().describe('Domain key to move the entity into'),
    })
    .strict(),
  add_observation: z.object({ content: z.string().min(1).max(10_000), tier: tierSchema.optional() }).strict(),
  retract_observation: z.object({ observation_id: z.string().regex(UUID) }).strict(),
  add_relation: z
    .object({
      type: z.string().describe('Relation type key, see get_ontology'),
      to: z.string().describe('Target entity: id, "type:name", or a unique name'),
      tier: tierSchema.optional(),
    })
    .strict(),
  remove_relation: z.object({ relation_id: z.string().regex(UUID) }).strict(),
  set_tier: z
    .object({ tier: tierSchema, observation_id: z.string().regex(UUID).optional().describe('Omit to change the entity itself') })
    .strict(),
  deprecate_entity: z.object({}).strict(),
  transfer_ownership: z.object({ new_owner: z.string().email() }).strict(),
} satisfies Record<ActionKey, z.ZodTypeAny>;

export const ACTIONS = Object.keys(actionSchemas) as ActionKey[];

/** Changes by someone other than the owner to these trigger an FYI to the owner. */
const OWNER_FYI_ACTIONS = new Set<ActionKey>(['update_entity', 'set_tier', 'deprecate_entity', 'retract_observation', 'remove_relation']);

interface Prepared {
  targets: WriteTarget[];
  normalized: Record<string, unknown>;
  summary: string;
}

interface Attribution {
  performedBy: Actor;
  creditUserId: string;
  creditTokenId: string | null;
  source: Source | null;
}

export function parse<T extends z.ZodTypeAny>(schema: T, data: unknown, what: string): z.output<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.') || what}: ${i.message}`).join('; ');
    throw invalid(`Invalid ${what}: ${issues}`);
  }
  return result.data;
}

export class Knowledge {
  private constructor(
    readonly db: Db,
    readonly tiers: Map<TierRank, Tier>,
    readonly publicUrl: string,
  ) {}

  static async create(db: Db, publicUrl: string): Promise<Knowledge> {
    const { rows } = await db.query<Tier>('select * from tiers order by rank');
    return new Knowledge(db, new Map(rows.map((t) => [t.rank, t])), publicUrl);
  }

  tierName(rank: TierRank): string {
    return this.tiers.get(rank)!.name;
  }

  link(path: string): string {
    return `${this.publicUrl}${path}`;
  }

  // ---------- lookups ----------

  async resolveEntity(q: Queryable, ref: string, opts: { lock?: boolean } = {}): Promise<EntityRow> {
    const lock = opts.lock ? ' for update' : '';
    const trimmed = ref.trim();
    if (UUID.test(trimmed)) {
      const { rows } = await q.query<EntityRow>(`select * from entities where id = $1${lock}`, [trimmed]);
      if (!rows[0]) throw notFound(`No entity with id ${trimmed}`);
      return rows[0];
    }
    const colon = trimmed.indexOf(':');
    if (colon > 0) {
      const typeKey = trimmed.slice(0, colon).trim();
      const name = trimmed.slice(colon + 1).trim();
      const { rows } = await q.query<EntityRow>(
        `select * from entities where type_key = $1 and lower(name) = lower($2) and status = 'active'${lock}`,
        [typeKey, name],
      );
      if (rows[0]) return rows[0];
    }
    const { rows } = await q.query<EntityRow>(
      `select * from entities where status = 'active' and (lower(name) = lower($1) or exists (select 1 from unnest(aliases) a where lower(a) = lower($1)))${lock}`,
      [trimmed],
    );
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) {
      throw invalid(`"${trimmed}" is ambiguous`, `Use one of: ${rows.map((r) => `${r.type_key}:${r.name} (${r.id})`).join(', ')}`);
    }
    throw notFound(`No entity matches "${trimmed}". Try search_knowledge first.`);
  }

  async entityType(q: Queryable, key: string): Promise<EntityTypeRow> {
    const { rows } = await q.query<EntityTypeRow>('select * from entity_types where key = $1', [key]);
    if (!rows[0]) {
      const all = await q.query<{ key: string }>('select key from entity_types order by key');
      throw invalid(`Unknown entity type "${key}"`, `Known types: ${all.rows.map((r) => r.key).join(', ')}`);
    }
    return rows[0];
  }

  async relationType(q: Queryable, key: string): Promise<RelationTypeRow> {
    const { rows } = await q.query<RelationTypeRow>('select * from relation_types where key = $1', [key]);
    if (!rows[0]) {
      const all = await q.query<{ key: string }>('select key from relation_types order by key');
      throw invalid(`Unknown relation type "${key}"`, `Known relation types: ${all.rows.map((r) => r.key).join(', ')}`);
    }
    return rows[0];
  }

  async domainByKey(q: Queryable, key: string): Promise<{ id: string; owner_id: string }> {
    const { rows } = await q.query<{ id: string; owner_id: string }>('select id, owner_id from domains where key = $1', [key]);
    if (!rows[0]) throw invalid(`Unknown domain "${key}"`);
    return rows[0];
  }

  async domainOwner(q: Queryable, domainId: string | null): Promise<string> {
    if (!domainId) return NOBODY;
    const { rows } = await q.query<{ owner_id: string }>('select owner_id from domains where id = $1', [domainId]);
    return rows[0]?.owner_id ?? NOBODY;
  }

  /**
   * Overwriting knowledge is governed by its owner and tier. Promoting knowledge INTO
   * Canon or Verified is governed by the domain: Canon needs the domain owner, Verified a
   * curator. Without this an owner could promote their own entity to Canon.
   */
  async promotionTarget(q: Queryable, tier: TierRank, domainId: string | null): Promise<WriteTarget> {
    return { tier, ownerId: await this.domainOwner(q, domainId), domainId };
  }

  validateProperties(type: EntityTypeRow, props: Record<string, unknown>, mode: 'create' | 'update'): void {
    const defs = new Map<string, PropertyDef>(type.properties.map((p) => [p.key, p]));
    for (const [key, value] of Object.entries(props)) {
      const def = defs.get(key);
      if (!def) {
        throw invalid(
          `Unknown property "${key}" for type "${type.key}"`,
          defs.size ? `Allowed: ${[...defs.keys()].join(', ')}. Record anything else as an observation.` : `Type "${type.key}" has no properties; use an observation.`,
        );
      }
      if (value === null) {
        if (mode === 'create' || def.required) throw invalid(`Property "${key}" cannot be null`);
        continue;
      }
      const ok =
        (def.type === 'string' && typeof value === 'string') ||
        (def.type === 'number' && typeof value === 'number') ||
        (def.type === 'boolean' && typeof value === 'boolean') ||
        (def.type === 'date' && typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))) ||
        (def.type === 'url' && typeof value === 'string' && URL.canParse(value)) ||
        (def.type === 'enum' && typeof value === 'string' && (def.options ?? []).includes(value));
      if (!ok) {
        const expected = def.type === 'enum' ? `one of ${(def.options ?? []).join(', ')}` : def.type;
        throw invalid(`Property "${key}" must be ${expected}`);
      }
    }
    if (mode === 'create') {
      const missing = type.properties.filter((p) => p.required && props[p.key] === undefined).map((p) => p.key);
      if (missing.length) throw invalid(`Missing required properties for "${type.key}": ${missing.join(', ')}`);
    }
  }

  private requireSource(actor: Actor, source: Source | null | undefined): void {
    if (actor.tokenKind === 'agent' && !source) {
      throw invalid('Agents must cite a source for every write', 'Pass source: { kind, ref?, url?, note? } describing where this came from.');
    }
  }

  private check(actor: Actor, targets: WriteTarget[], ownerName: string, verb = 'make this change'): void {
    for (const target of targets) {
      const decision = canWrite(actor, target, this.tiers);
      if (!decision.ok) {
        throw forbidden(`You can't ${verb}: ${decision.message}`, `Use request_update to ask the owner (${ownerName}) to review it.`);
      }
    }
  }

  private async userName(q: Queryable, id: string): Promise<string> {
    const { rows } = await q.query<{ name: string; email: string }>('select name, email from users where id = $1', [id]);
    return rows[0] ? `${rows[0].name} <${rows[0].email}>` : 'nobody';
  }

  // ---------- creating entities ----------

  async createEntity(
    actor: Actor,
    input: {
      type: string;
      name: string;
      summary?: string;
      aliases?: string[];
      properties?: Record<string, unknown>;
      tier?: TierRank;
      domain?: string;
      owner_email?: string;
    },
    source?: Source | null,
  ): Promise<EntityRow> {
    this.requireSource(actor, source);
    return withTx(this.db, async (tx) => {
      const type = await this.entityType(tx, input.type);
      const properties = input.properties ?? {};
      this.validateProperties(type, properties, 'create');

      let domainId = type.domain_id;
      if (input.domain) domainId = (await this.domainByKey(tx, input.domain)).id;

      let ownerId = actor.userId;
      if (input.owner_email && input.owner_email.toLowerCase() !== actor.email.toLowerCase()) {
        if (actor.role !== 'admin' && !(domainId && actor.ownedDomainIds.has(domainId))) {
          throw forbidden('Only admins and the domain owner can create knowledge on behalf of someone else');
        }
        const { rows } = await tx.query<{ id: string }>('select id from users where email = $1', [input.owner_email]);
        if (!rows[0]) throw invalid(`No user with email ${input.owner_email}`);
        ownerId = rows[0].id;
      }

      const creatable = async (tier: TierRank) => {
        const targets: WriteTarget[] = [{ tier, ownerId: actor.userId, domainId }];
        if (tier <= 2) targets.push(await this.promotionTarget(tx, tier, domainId));
        for (const t of targets) {
          const d = canWrite(actor, t, this.tiers);
          if (!d.ok) return d;
        }
        return null;
      };
      let tier: TierRank;
      if (input.tier) {
        tier = input.tier;
        const denied = await creatable(tier);
        if (denied) {
          throw forbidden(
            `You can't create ${this.tierName(tier)} knowledge here: ${denied.message}`,
            'Create it at a lower tier, then request_update with action set_tier to have it promoted.',
          );
        }
      } else {
        // Start at the type's default and step down to the most trusted tier this actor may create.
        tier = type.default_tier;
        while (tier < 4 && (await creatable(tier))) tier = (tier + 1) as TierRank;
      }

      try {
        const { rows } = await tx.query<EntityRow>(
          `insert into entities (type_key, name, aliases, summary, properties, tier, owner_id, domain_id, created_by, updated_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9) returning *`,
          [type.key, input.name.trim(), input.aliases ?? [], input.summary ?? '', properties, tier, ownerId, domainId, actor.userId],
        );
        const entity = rows[0];
        if (source) {
          await tx.query(`insert into observations (entity_id, content, tier, source, author_id, token_id) values ($1, $2, $3, $4, $5, $6)`, [
            entity.id,
            `Created from ${source.kind ?? 'source'}${source.ref ? ` ${source.ref}` : ''}${source.note ? `: ${source.note}` : ''}`,
            Math.max(tier, defaultFactTier(actor)),
            source,
            actor.userId,
            actor.tokenId,
          ]);
        }
        await audit(tx, { actorId: actor.userId, tokenId: actor.tokenId, action: 'entity.create', targetKind: 'entity', targetId: entity.id, entityId: entity.id, after: entity });
        return entity;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw conflict(`A ${type.key} named "${input.name}" already exists`, 'Add to the existing entity, or give this one a distinguishing name.');
        }
        throw err;
      }
    });
  }

  // ---------- actions on existing entities ----------

  private async prepare(tx: Tx, entity: EntityRow, action: ActionKey, payload: Record<string, unknown>, mode: 'direct' | 'request', actor: Actor): Promise<Prepared> {
    const entityTarget: WriteTarget = { tier: entity.tier, ownerId: entity.owner_id, domainId: entity.domain_id };
    const factDefault = (): TierRank => (mode === 'direct' ? (Math.max(defaultFactTier(actor), entity.tier) as TierRank) : entity.tier);
    const assertFactTier = (tier: TierRank) => {
      if (tier < entity.tier) {
        throw invalid(`A fact can't be more trusted than its entity (${this.tierName(entity.tier)})`, 'Promote the entity first with set_tier.');
      }
    };

    switch (action) {
      case 'update_entity': {
        const p = parse(actionSchemas.update_entity, payload, 'update_entity payload');
        if (Object.keys(p).length === 0) throw invalid('Nothing to update');
        const targets = [entityTarget];
        const normalized: Record<string, unknown> = { ...p };
        if (p.properties) this.validateProperties(await this.entityType(tx, entity.type_key), p.properties, 'update');
        if (p.domain !== undefined) {
          const domain = await this.domainByKey(tx, p.domain);
          targets.push({ ...entityTarget, ownerOnly: true });
          if (entity.tier <= 2) targets.push(await this.promotionTarget(tx, entity.tier, domain.id));
        }
        const fields = Object.keys(p).join(', ');
        return { targets, normalized, summary: `Update ${fields} on ${entity.type_key}:${entity.name}` };
      }
      case 'add_observation': {
        const p = parse(actionSchemas.add_observation, payload, 'add_observation payload');
        const tier = p.tier ?? factDefault();
        assertFactTier(tier);
        return {
          targets: [{ ...entityTarget, tier }],
          normalized: { content: p.content, tier },
          summary: `Add ${this.tierName(tier)} fact to ${entity.name}: "${truncate(p.content, 120)}"`,
        };
      }
      case 'retract_observation': {
        const p = parse(actionSchemas.retract_observation, payload, 'retract_observation payload');
        const obs = await this.observation(tx, entity, p.observation_id);
        return {
          targets: [{ ...entityTarget, tier: obs.tier }],
          normalized: p,
          summary: `Retract fact on ${entity.name}: "${truncate(obs.content, 120)}"`,
        };
      }
      case 'add_relation': {
        const p = parse(actionSchemas.add_relation, payload, 'add_relation payload');
        const relType = await this.relationType(tx, p.type);
        const to = await this.resolveEntity(tx, p.to);
        if (relType.from_types && !relType.from_types.includes(entity.type_key)) {
          throw invalid(`"${relType.key}" can't start from a ${entity.type_key}`, `Allowed from: ${relType.from_types.join(', ')}`);
        }
        if (relType.to_types && !relType.to_types.includes(to.type_key)) {
          throw invalid(`"${relType.key}" can't point to a ${to.type_key}`, `Allowed to: ${relType.to_types.join(', ')}`);
        }
        const tier = p.tier ?? (Math.max(factDefault(), to.tier) as TierRank);
        assertFactTier(tier);
        const dup = await tx.query(`select 1 from relations where type_key = $1 and from_id = $2 and to_id = $3 and status = 'active'`, [relType.key, entity.id, to.id]);
        if (dup.rowCount) throw conflict(`${entity.name} already ${relType.name} ${to.name}`);
        return {
          targets: [{ ...entityTarget, tier }],
          normalized: { type: relType.key, to: to.id, tier },
          summary: `Link ${entity.name} → ${relType.name} → ${to.name} (${this.tierName(tier)})`,
        };
      }
      case 'remove_relation': {
        const p = parse(actionSchemas.remove_relation, payload, 'remove_relation payload');
        const { rows } = await tx.query<RelationRow & { from_owner: string; from_domain: string | null; from_name: string; to_name: string }>(
          `select r.*, f.owner_id as from_owner, f.domain_id as from_domain, f.name as from_name, t.name as to_name
           from relations r join entities f on f.id = r.from_id join entities t on t.id = r.to_id
           where r.id = $1 and r.status = 'active' and (r.from_id = $2 or r.to_id = $2)`,
          [p.relation_id, entity.id],
        );
        const rel = rows[0];
        if (!rel) throw notFound(`No active relation ${p.relation_id} on ${entity.name}`);
        return {
          targets: [{ tier: rel.tier, ownerId: rel.from_owner, domainId: rel.from_domain }],
          normalized: p,
          summary: `Remove link ${rel.from_name} → ${rel.type_key} → ${rel.to_name}`,
        };
      }
      case 'set_tier': {
        const p = parse(actionSchemas.set_tier, payload, 'set_tier payload');
        if (p.observation_id) {
          const obs = await this.observation(tx, entity, p.observation_id);
          if (obs.tier === p.tier) throw invalid(`That fact is already ${this.tierName(p.tier)}`);
          assertFactTier(p.tier);
          return {
            targets: [{ ...entityTarget, tier: obs.tier }, { ...entityTarget, tier: p.tier }],
            normalized: p,
            summary: `Move fact on ${entity.name} from ${this.tierName(obs.tier)} to ${this.tierName(p.tier)}: "${truncate(obs.content, 100)}"`,
          };
        }
        if (entity.tier === p.tier) throw invalid(`${entity.name} is already ${this.tierName(p.tier)}`);
        const targets: WriteTarget[] = [entityTarget, { ...entityTarget, tier: p.tier }];
        if (p.tier < entity.tier && p.tier <= 2) targets.push(await this.promotionTarget(tx, p.tier, entity.domain_id));
        const verb = p.tier < entity.tier ? 'Promote' : 'Demote';
        return { targets, normalized: p, summary: `${verb} ${entity.name} from ${this.tierName(entity.tier)} to ${this.tierName(p.tier)}` };
      }
      case 'deprecate_entity': {
        parse(actionSchemas.deprecate_entity, payload, 'deprecate_entity payload');
        if (entity.status === 'deprecated') throw invalid(`${entity.name} is already deprecated`);
        return { targets: [entityTarget], normalized: {}, summary: `Deprecate ${entity.type_key}:${entity.name}` };
      }
      case 'transfer_ownership': {
        const p = parse(actionSchemas.transfer_ownership, payload, 'transfer_ownership payload');
        const { rows } = await tx.query<{ id: string; name: string }>('select id, name from users where email = $1', [p.new_owner]);
        if (!rows[0]) throw invalid(`No user with email ${p.new_owner}`);
        if (rows[0].id === entity.owner_id) throw invalid(`${rows[0].name} already owns ${entity.name}`);
        return { targets: [{ ...entityTarget, ownerOnly: true }], normalized: p, summary: `Transfer ${entity.name} to ${rows[0].name}` };
      }
    }
  }

  private async apply(tx: Tx, entity: EntityRow, action: ActionKey, p: Record<string, unknown>, attr: Attribution): Promise<Record<string, unknown>> {
    const by = attr.performedBy;
    const bump = async (sets: string, params: unknown[]): Promise<EntityRow> => {
      const { rows } = await tx.query<EntityRow>(
        `update entities set ${sets}, version = version + 1, updated_by = $2, updated_at = now() where id = $1 returning *`,
        [entity.id, attr.creditUserId, ...params],
      );
      return rows[0];
    };
    const event = (kind: 'entity' | 'observation' | 'relation', targetId: string, before: unknown, after: unknown) =>
      audit(tx, { actorId: by.userId, tokenId: by.tokenId, action: action, targetKind: kind, targetId, entityId: entity.id, before, after });

    switch (action) {
      case 'update_entity': {
        const u = p as z.output<typeof actionSchemas.update_entity>;
        const props = { ...entity.properties };
        for (const [k, v] of Object.entries(u.properties ?? {})) {
          if (v === null) delete props[k];
          else props[k] = v;
        }
        const domainId = u.domain !== undefined ? (await this.domainByKey(tx, u.domain)).id : entity.domain_id;
        try {
          const updated = await bump('name = $3, summary = $4, aliases = $5, properties = $6, domain_id = $7', [
            u.name?.trim() ?? entity.name,
            u.summary ?? entity.summary,
            u.aliases ?? entity.aliases,
            props,
            domainId,
          ]);
          await event('entity', entity.id, entity, updated);
          return { entity: updated };
        } catch (err) {
          if ((err as { code?: string }).code === '23505') throw conflict(`Another ${entity.type_key} is already named "${u.name}"`);
          throw err;
        }
      }
      case 'add_observation': {
        const { rows } = await tx.query<ObservationRow>(
          `insert into observations (entity_id, content, tier, source, author_id, token_id) values ($1, $2, $3, $4, $5, $6) returning *`,
          [entity.id, p.content, p.tier, attr.source, attr.creditUserId, attr.creditTokenId],
        );
        await event('observation', rows[0].id, null, rows[0]);
        return { observation: rows[0] };
      }
      case 'retract_observation': {
        const { rows } = await tx.query<ObservationRow>(`update observations set status = 'retracted' where id = $1 returning *`, [p.observation_id]);
        await event('observation', rows[0].id, { status: 'active' }, { status: 'retracted' });
        return { observation: rows[0] };
      }
      case 'add_relation': {
        const { rows } = await tx.query<RelationRow>(
          `insert into relations (type_key, from_id, to_id, tier, source, created_by, token_id) values ($1, $2, $3, $4, $5, $6, $7) returning *`,
          [p.type, entity.id, p.to, p.tier, attr.source, attr.creditUserId, attr.creditTokenId],
        );
        await event('relation', rows[0].id, null, rows[0]);
        return { relation: rows[0] };
      }
      case 'remove_relation': {
        const { rows } = await tx.query<RelationRow>(`update relations set status = 'removed' where id = $1 returning *`, [p.relation_id]);
        await event('relation', rows[0].id, { status: 'active' }, { status: 'removed' });
        return { relation: rows[0] };
      }
      case 'set_tier': {
        if (p.observation_id) {
          const { rows } = await tx.query<ObservationRow>(`update observations set tier = $2 where id = $1 returning *`, [p.observation_id, p.tier]);
          await event('observation', rows[0].id, null, { tier: p.tier });
          return { observation: rows[0] };
        }
        const updated = await bump('tier = $3', [p.tier]);
        // Keep the invariant that no fact outranks its entity.
        await tx.query(`update observations set tier = $2 where entity_id = $1 and tier < $2`, [entity.id, p.tier]);
        await tx.query(`update relations set tier = $2 where from_id = $1 and tier < $2`, [entity.id, p.tier]);
        await event('entity', entity.id, { tier: entity.tier }, { tier: p.tier });
        return { entity: updated };
      }
      case 'deprecate_entity': {
        const updated = await bump(`status = 'deprecated'`, []);
        await event('entity', entity.id, { status: entity.status }, { status: 'deprecated' });
        return { entity: updated };
      }
      case 'transfer_ownership': {
        const { rows } = await tx.query<{ id: string }>('select id from users where email = $1', [p.new_owner]);
        const updated = await bump('owner_id = $3', [rows[0].id]);
        await event('entity', entity.id, { owner_id: entity.owner_id }, { owner_id: rows[0].id });
        await notify(tx, {
          userId: rows[0].id,
          kind: 'entity.transferred',
          title: `You now own ${entity.name}`,
          body: `${by.name} transferred ${entity.type_key}:${entity.name} to you.`,
          link: this.link(`/e/${entity.id}`),
        });
        return { entity: updated };
      }
    }
  }

  private async observation(q: Queryable, entity: EntityRow, id: string): Promise<ObservationRow> {
    const { rows } = await q.query<ObservationRow>(`select * from observations where id = $1 and entity_id = $2 and status = 'active'`, [id, entity.id]);
    if (!rows[0]) throw notFound(`No active fact ${id} on ${entity.name}`);
    return rows[0];
  }

  /** Make a change directly. Fails with a hint to use request_update when policy says no. */
  async perform(
    actor: Actor,
    entityRef: string,
    action: ActionKey,
    payload: Record<string, unknown>,
    source?: Source | null,
  ): Promise<Record<string, unknown> & { summary: string }> {
    this.requireSource(actor, source);
    return withTx(this.db, async (tx) => {
      const entity = await this.resolveEntity(tx, entityRef, { lock: true });
      const prepared = await this.prepare(tx, entity, action, payload, 'direct', actor);
      this.check(actor, prepared.targets, await this.userName(tx, entity.owner_id));
      const result = await this.apply(tx, entity, action, prepared.normalized, {
        performedBy: actor,
        creditUserId: actor.userId,
        creditTokenId: actor.tokenId,
        source: source ?? null,
      });
      if (actor.userId !== entity.owner_id && OWNER_FYI_ACTIONS.has(action)) {
        await notify(tx, {
          userId: entity.owner_id,
          kind: 'entity.changed',
          title: `${actor.name} changed ${entity.name}`,
          body: prepared.summary,
          link: this.link(`/e/${entity.id}`),
        });
      }
      return { summary: prepared.summary, ...result };
    });
  }

  // ---------- change requests ----------

  async requestUpdate(
    actor: Actor,
    input: { entity: string; action: ActionKey; payload: Record<string, unknown>; rationale: string; source?: Source | null },
  ): Promise<ChangeRequestRow> {
    this.requireSource(actor, input.source);
    return withTx(this.db, async (tx) => {
      const entity = await this.resolveEntity(tx, input.entity);
      const prepared = await this.prepare(tx, entity, input.action, input.payload, 'request', actor);
      const assigneeId = await this.pickAssignee(tx, entity, prepared.targets);
      const { rows } = await tx.query<ChangeRequestRow>(
        `insert into change_requests (entity_id, action, payload, summary, rationale, source, base_version, requested_by, token_id, assignee_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning *`,
        [entity.id, input.action, prepared.normalized, prepared.summary, input.rationale, input.source ?? null, entity.version, actor.userId, actor.tokenId, assigneeId],
      );
      const request = rows[0];
      const via = actor.tokenKind === 'agent' ? ' (via agent)' : '';
      const ping = {
        kind: 'request.created' as const,
        title: `${actor.name}${via} requests a change to ${entity.name}`,
        body: `${prepared.summary}\nWhy: ${input.rationale}`,
        link: this.link(`/requests/${request.id}`),
        requestId: request.id,
      };
      await notify(tx, { userId: assigneeId, ...ping });
      if (assigneeId !== entity.owner_id) {
        await notify(tx, { userId: entity.owner_id, ...ping, title: `FYI: ${ping.title} (routed to ${await this.userName(tx, assigneeId)})` });
      }
      await audit(tx, { actorId: actor.userId, tokenId: actor.tokenId, action: 'request.create', targetKind: 'request', targetId: request.id, entityId: entity.id, after: request });
      return request;
    });
  }

  /** The owner reviews by default. If the owner couldn't approve it (e.g. a promotion to Canon), it goes to the domain owner, then an admin. */
  private async pickAssignee(tx: Tx, entity: EntityRow, targets: WriteTarget[]): Promise<string> {
    const domainOwner = await this.domainOwner(tx, entity.domain_id);
    const admins = await tx.query<{ id: string }>(`select id from users where role = 'admin' order by created_at`);
    const candidates = [entity.owner_id, domainOwner, ...admins.rows.map((r) => r.id)].filter((id) => id !== NOBODY);
    for (const id of candidates) {
      const candidate = await humanActorFor(tx, id);
      if (candidate && targets.every((t) => canWrite(candidate, t, this.tiers).ok)) return id;
    }
    return entity.owner_id;
  }

  async curate(
    actor: Actor,
    input: { request_id: string; decision: 'approve' | 'reject'; note?: string; edits?: Record<string, unknown> },
  ): Promise<{ request: ChangeRequestRow; result?: Record<string, unknown>; stale?: boolean }> {
    return withTx(this.db, async (tx) => {
      const { rows } = await tx.query<ChangeRequestRow>('select * from change_requests where id = $1 for update', [input.request_id]);
      const request = rows[0];
      if (!request) throw notFound(`No request ${input.request_id}`);
      if (request.status !== 'open') throw conflict(`Request is already ${request.status}`);

      const entity = await this.resolveEntity(tx, request.entity_id, { lock: true });
      const ownerName = await this.userName(tx, entity.owner_id);
      const stale = entity.version !== request.base_version;

      let result: Record<string, unknown> | undefined;
      let applied: Record<string, unknown> | null = null;
      let payload = request.payload;
      let summary = request.summary;
      if (input.decision === 'approve') {
        const prepared = await this.prepare(tx, entity, request.action, input.edits ? { ...request.payload, ...input.edits } : request.payload, 'request', actor);
        this.check(actor, prepared.targets, ownerName, 'approve this request');
        result = await this.apply(tx, entity, request.action, prepared.normalized, {
          performedBy: actor,
          creditUserId: request.requested_by,
          creditTokenId: request.token_id,
          source: request.source,
        });
        payload = prepared.normalized;
        summary = prepared.summary;
        applied = { edited: Boolean(input.edits), stale, base_version: request.base_version, applied_to_version: entity.version };
      } else if (actor.userId !== request.assignee_id && actor.role !== 'admin') {
        // Anyone else who could have applied the change may also turn it down.
        const prepared = await this.prepare(tx, entity, request.action, request.payload, 'request', actor);
        this.check(actor, prepared.targets, ownerName, 'reject this request');
      }

      const updated = await tx.query<ChangeRequestRow>(
        `update change_requests set status = $2, resolution_note = $3, resolved_by = $4, resolved_at = now(), applied = $5, payload = $6, summary = $7
         where id = $1 returning *`,
        [request.id, input.decision === 'approve' ? 'approved' : 'rejected', input.note ?? null, actor.userId, applied, payload, summary],
      );
      if (request.requested_by !== actor.userId) {
        const verdict = input.decision === 'approve' ? (input.edits ? 'approved with edits' : 'approved') : 'rejected';
        await notify(tx, {
          userId: request.requested_by,
          kind: 'request.resolved',
          title: `${actor.name} ${verdict} your request on ${entity.name}`,
          body: [summary, input.note ? `Note: ${input.note}` : ''].filter(Boolean).join('\n'),
          link: this.link(`/requests/${request.id}`),
          requestId: request.id,
        });
      }
      await audit(tx, {
        actorId: actor.userId,
        tokenId: actor.tokenId,
        action: `request.${input.decision}`,
        targetKind: 'request',
        targetId: request.id,
        entityId: entity.id,
        after: { note: input.note, edits: input.edits },
      });
      return { request: updated.rows[0], result, stale };
    });
  }

  async withdraw(actor: Actor, requestId: string): Promise<ChangeRequestRow> {
    const { rows } = await this.db.query<ChangeRequestRow>(
      `update change_requests set status = 'withdrawn', resolved_by = $2, resolved_at = now()
       where id = $1 and requested_by = $2 and status = 'open' returning *`,
      [requestId, actor.userId],
    );
    if (!rows[0]) throw notFound('No open request of yours with that id');
    await audit(this.db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'request.withdraw', targetKind: 'request', targetId: requestId, entityId: rows[0].entity_id });
    return rows[0];
  }

  async listRequests(actor: Actor, opts: { box: 'assigned' | 'mine' | 'all'; status?: ChangeRequestRow['status'] | 'any'; entityId?: string; limit?: number }) {
    const status = opts.status ?? 'open';
    const { rows } = await this.db.query<RequestListRow>(
      `select cr.*, e.name as entity_name, e.type_key as entity_type, e.tier as entity_tier,
              rq.name as requested_by_name, rq.email as requested_by_email, a.name as assignee_name,
              rs.name as resolved_by_name, t.kind as token_kind, t.name as token_name
       from change_requests cr
       join entities e on e.id = cr.entity_id
       join users rq on rq.id = cr.requested_by
       join users a on a.id = cr.assignee_id
       left join users rs on rs.id = cr.resolved_by
       left join api_tokens t on t.id = cr.token_id
       where ($1 <> 'assigned' or cr.assignee_id = $2)
         and ($1 <> 'mine' or cr.requested_by = $2)
         and ($3 = 'any' or cr.status = $3)
         and ($4::uuid is null or cr.entity_id = $4)
       order by cr.created_at desc limit $5`,
      [opts.box, actor.userId, status, opts.entityId ?? null, opts.limit ?? 50],
    );
    return rows;
  }

  async getRequest(id: string): Promise<RequestListRow> {
    const { rows } = await this.db.query<RequestListRow>(
      `select cr.*, e.name as entity_name, e.type_key as entity_type, e.tier as entity_tier,
              rq.name as requested_by_name, rq.email as requested_by_email, a.name as assignee_name,
              rs.name as resolved_by_name, t.kind as token_kind, t.name as token_name
       from change_requests cr
       join entities e on e.id = cr.entity_id
       join users rq on rq.id = cr.requested_by
       join users a on a.id = cr.assignee_id
       left join users rs on rs.id = cr.resolved_by
       left join api_tokens t on t.id = cr.token_id
       where cr.id = $1`,
      [id],
    );
    if (!rows[0]) throw notFound(`No request ${id}`);
    return rows[0];
  }

  /** Whether the actor could apply this action directly. Used to pick "edit" vs "request" in the UI. */
  async wouldAllow(actor: Actor, entityId: string, action: ActionKey, payload: Record<string, unknown>): Promise<boolean> {
    try {
      await withTx(this.db, async (tx) => {
        const entity = await this.resolveEntity(tx, entityId);
        const prepared = await this.prepare(tx, entity, action, payload, 'direct', actor);
        this.check(actor, prepared.targets, '');
      });
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'forbidden') return false;
      throw err;
    }
  }

  // ---------- reads ----------

  async getEntity(ref: string, opts: { includeRetracted?: boolean } = {}): Promise<EntityDetail> {
    const entity = await this.resolveEntity(this.db, ref);
    const [meta, observations, outgoing, incoming, openRequests] = await Promise.all([
      this.db.query<{ owner_name: string; owner_email: string; domain_key: string | null; domain_name: string | null; type_name: string }>(
        `select u.name as owner_name, u.email as owner_email, d.key as domain_key, d.name as domain_name, et.name as type_name
         from entities e join users u on u.id = e.owner_id join entity_types et on et.key = e.type_key left join domains d on d.id = e.domain_id
         where e.id = $1`,
        [entity.id],
      ),
      this.db.query<ObservationRow & { author_name: string; token_kind: string | null }>(
        `select o.*, u.name as author_name, t.kind as token_kind from observations o join users u on u.id = o.author_id
         left join api_tokens t on t.id = o.token_id
         where o.entity_id = $1 and ($2 or o.status = 'active') order by o.tier, o.created_at desc`,
        [entity.id, opts.includeRetracted ?? false],
      ),
      this.db.query<RelationRow & { other_id: string; other_name: string; other_type: string; label: string }>(
        `select r.*, t.id as other_id, t.name as other_name, t.type_key as other_type, rt.name as label
         from relations r join entities t on t.id = r.to_id join relation_types rt on rt.key = r.type_key
         where r.from_id = $1 and r.status = 'active' order by rt.name, t.name`,
        [entity.id],
      ),
      this.db.query<RelationRow & { other_id: string; other_name: string; other_type: string; label: string }>(
        `select r.*, f.id as other_id, f.name as other_name, f.type_key as other_type, coalesce(rt.inverse_name, rt.name || ' (inverse)') as label
         from relations r join entities f on f.id = r.from_id join relation_types rt on rt.key = r.type_key
         where r.to_id = $1 and r.status = 'active' order by rt.name, f.name`,
        [entity.id],
      ),
      this.db.query<{ count: string }>(`select count(*) from change_requests where entity_id = $1 and status = 'open'`, [entity.id]),
    ]);
    return {
      entity,
      ...meta.rows[0],
      tier_name: this.tierName(entity.tier),
      observations: observations.rows,
      outgoing: outgoing.rows,
      incoming: incoming.rows,
      open_requests: Number(openRequests.rows[0].count),
    };
  }

  async search(query: string, opts: { type?: string; maxTier?: TierRank; limit?: number; includeDeprecated?: boolean } = {}) {
    const { rows } = await this.db.query<EntityRow & { score: number; owner_name: string; matched_fact: string | null }>(
      `with q as (select websearch_to_tsquery('english', $1) as tsq)
       select e.*, u.name as owner_name,
         (select o.content from observations o, q where o.entity_id = e.id and o.status = 'active' and o.search @@ q.tsq
            order by ts_rank(o.search, q.tsq) desc limit 1) as matched_fact,
         ts_rank(e.search, q.tsq) * 2 + similarity(e.name, $1)
           + coalesce((select max(ts_rank(o.search, q.tsq)) from observations o where o.entity_id = e.id and o.status = 'active'), 0)
           + (4 - e.tier) * 0.05 as score
       from entities e cross join q join users u on u.id = e.owner_id
       where ($5 or e.status = 'active')
         and ($2::text is null or e.type_key = $2)
         and ($3::int is null or e.tier <= $3)
         and (e.search @@ q.tsq or e.name % $1 or e.name ilike '%' || $1 || '%'
              or exists (select 1 from unnest(e.aliases) a where a ilike '%' || $1 || '%')
              or exists (select 1 from observations o where o.entity_id = e.id and o.status = 'active' and o.search @@ q.tsq))
       order by score desc, e.updated_at desc limit $4`,
      [query, opts.type ?? null, opts.maxTier ?? null, opts.limit ?? 20, opts.includeDeprecated ?? false],
    );
    return rows;
  }

  async neighbors(ref: string, opts: { depth?: number; relationType?: string; limit?: number } = {}) {
    const root = await this.resolveEntity(this.db, ref);
    const depth = Math.min(Math.max(opts.depth ?? 1, 1), 3);
    const { rows: edges } = await this.db.query<{ id: string; type_key: string; from_id: string; to_id: string; tier: TierRank }>(
      `with recursive walk(entity_id, depth) as (
         select $1::uuid, 0
         union
         select case when r.from_id = w.entity_id then r.to_id else r.from_id end, w.depth + 1
         from walk w join relations r on (r.from_id = w.entity_id or r.to_id = w.entity_id)
         where w.depth < $2 and r.status = 'active' and ($3::text is null or r.type_key = $3)
       )
       select distinct r.id, r.type_key, r.from_id, r.to_id, r.tier
       from relations r
       where r.status = 'active' and ($3::text is null or r.type_key = $3)
         and r.from_id in (select entity_id from walk) and r.to_id in (select entity_id from walk)
       limit $4`,
      [root.id, depth, opts.relationType ?? null, opts.limit ?? 200],
    );
    const ids = [...new Set([root.id, ...edges.flatMap((e) => [e.from_id, e.to_id])])];
    const { rows: nodes } = await this.db.query<Pick<EntityRow, 'id' | 'name' | 'type_key' | 'tier' | 'status'>>(
      'select id, name, type_key, tier, status from entities where id = any($1)',
      [ids],
    );
    return { root: root.id, nodes, edges };
  }

  async recentEvents(opts: { entityId?: string; limit?: number } = {}) {
    const { rows } = await this.db.query<{
      id: string;
      action: string;
      target_kind: string;
      target_id: string | null;
      entity_id: string | null;
      entity_name: string | null;
      actor_name: string | null;
      token_kind: string | null;
      created_at: Date;
    }>(
      `select ev.id, ev.action, ev.target_kind, ev.target_id, ev.entity_id, e.name as entity_name, u.name as actor_name, t.kind as token_kind, ev.created_at
       from events ev left join entities e on e.id = ev.entity_id left join users u on u.id = ev.actor_id left join api_tokens t on t.id = ev.token_id
       where ($1::uuid is null or ev.entity_id = $1) order by ev.created_at desc limit $2`,
      [opts.entityId ?? null, opts.limit ?? 50],
    );
    return rows;
  }
}

export interface RequestListRow extends ChangeRequestRow {
  entity_name: string;
  entity_type: string;
  entity_tier: TierRank;
  requested_by_name: string;
  requested_by_email: string;
  assignee_name: string;
  resolved_by_name: string | null;
  token_kind: 'human' | 'agent' | null;
  token_name: string | null;
}

export interface EntityDetail {
  entity: EntityRow;
  owner_name: string;
  owner_email: string;
  domain_key: string | null;
  domain_name: string | null;
  type_name: string;
  tier_name: string;
  observations: (ObservationRow & { author_name: string; token_kind: string | null })[];
  outgoing: (RelationRow & { other_id: string; other_name: string; other_type: string; label: string })[];
  incoming: (RelationRow & { other_id: string; other_name: string; other_type: string; label: string })[];
  open_requests: number;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
