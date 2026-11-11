import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { ACTIONS, actionSchemas, sourceSchema, tierSchema, type EntityDetail, type Knowledge } from '../services/knowledge.js';
import { listNotifications, markRead } from '../services/notify.js';
import { defineEntityType, defineRelationType, getOntology } from '../services/ontology.js';
import { recall } from '../services/recall.js';
import type { ActionKey, Actor, TierRank } from '../types.js';

const INSTRUCTIONS = `Commonplace is your team's shared knowledge graph: entities (people, organizations, projects, decisions...) connected by typed relations, with facts ("observations") attached to entities.

Every entity and fact has a trust tier:
  1 Canon    - foundational truth. Only its owner changes it.
  2 Verified - checked by someone who knows. Owner and domain curators change it.
  3 Working  - team knowledge in active use. Any member changes it.
  4 Raw      - unreviewed. Where agents and imports land.
Lower numbers are more trusted. Prefer Canon and Verified facts when answering; say so when you rely on Raw ones.

Every entity has an owner. Your token has a ceiling tier it can write to directly. When a write is refused, do not retry: call request_update with the same change and a short rationale. The owner is pinged and answers with curate_knowledge. Always pass a source describing where knowledge came from.

At the start of a task, call recall with the task description to pull in what the team already knows about it. Before creating an entity, search_knowledge to avoid duplicates. Use get_ontology to see entity types, their properties, and relation types.`;

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

function fail(err: unknown, suggestedRequest?: Record<string, unknown>): ToolResult {
  if (err instanceof AppError) {
    const body: Record<string, unknown> = { error: err.code, message: err.message };
    if (err.hint) body.hint = err.hint;
    if (err.code === 'forbidden' && suggestedRequest) body.suggested_request_update = { ...suggestedRequest, rationale: '<why this change is right>' };
    return { content: [{ type: 'text', text: JSON.stringify(body, null, 2) }], isError: true };
  }
  console.error(err);
  return { content: [{ type: 'text', text: JSON.stringify({ error: 'internal', message: 'Something went wrong on the server.' }) }], isError: true };
}

function tierLabel(k: Knowledge, rank: TierRank) {
  return `${k.tierName(rank)} (${rank})`;
}

function present(k: Knowledge, d: EntityDetail) {
  const e = d.entity;
  return {
    id: e.id,
    ref: `${e.type_key}:${e.name}`,
    type: e.type_key,
    name: e.name,
    aliases: e.aliases,
    status: e.status,
    tier: tierLabel(k, e.tier),
    owner: `${d.owner_name} <${d.owner_email}>`,
    domain: d.domain_key,
    version: e.version,
    summary: e.summary,
    properties: e.properties,
    facts: d.observations.map((o) => ({
      id: o.id,
      tier: tierLabel(k, o.tier),
      content: o.content,
      by: `${o.author_name}${o.token_kind === 'agent' ? ' (agent)' : ''}`,
      source: o.source,
      status: o.status,
      at: o.created_at,
    })),
    links: [
      ...d.outgoing.map((r) => ({ relation_id: r.id, reads: `${e.name} ${r.label} ${r.other_name}`, type: r.type_key, entity: `${r.other_type}:${r.other_name}`, entity_id: r.other_id, tier: tierLabel(k, r.tier) })),
      ...d.incoming.map((r) => ({ relation_id: r.id, reads: `${e.name} ${r.label} ${r.other_name}`, type: r.type_key, entity: `${r.other_type}:${r.other_name}`, entity_id: r.other_id, tier: tierLabel(k, r.tier) })),
    ],
    open_requests: d.open_requests,
    url: k.link(`/e/${e.id}`),
  };
}

const entityRef = z.string().describe('Entity id, "type:name" (e.g. "person:Ada Lovelace"), or a unique name');
const source = sourceSchema.optional().describe('Where this knowledge came from. Required for agent tokens.');

export function buildMcpServer(k: Knowledge, actor: Actor): McpServer {
  const server = new McpServer({ name: 'commonplace', version: '0.1.0' }, { instructions: INSTRUCTIONS });
  const db = k.db;

  const run = async (fn: () => Promise<unknown>, suggested?: Record<string, unknown>): Promise<ToolResult> => {
    try {
      return ok(await fn());
    } catch (err) {
      return fail(err, suggested);
    }
  };

  const change = async (entity: string, action: ActionKey, payload: Record<string, unknown>, src?: z.infer<typeof sourceSchema>) =>
    run(async () => {
      const result = await k.perform(actor, entity, action, payload, src ?? null);
      return { done: result.summary, ...result };
    }, { entity, action, payload, source: src });

  // ---------- read ----------

  server.registerTool(
    'whoami',
    { title: 'Who am I', description: 'Your identity, role, token kind, the highest tier you can write directly, and domains you curate.', annotations: { readOnlyHint: true } },
    async () =>
      run(async () => ({
        name: actor.name,
        email: actor.email,
        role: actor.role,
        token: actor.tokenKind,
        write_ceiling: tierLabel(k, actor.ceiling),
        curates_domains: [...actor.curatedDomainIds].length,
        owns_domains: [...actor.ownedDomainIds].length,
      })),
  );

  server.registerTool(
    'recall',
    {
      title: 'Recall context',
      description:
        'Paste a task, prompt or question and get back the few entities it is clearly about, with their most trusted facts, as plain text. Returns nothing when nothing matches well. Built for hooks that run on every prompt.',
      inputSchema: { text: z.string().min(1).max(20_000).describe('The prompt, task description or question') },
      annotations: { readOnlyHint: true },
    },
    async ({ text }) => run(async () => (await recall(k, actor, { text, via: 'tool' })).text),
  );

  server.registerTool(
    'get_ontology',
    { title: 'Get ontology', description: 'Trust tiers, domains (with owners and curators), entity types with their properties, and relation types.', annotations: { readOnlyHint: true } },
    async () => run(() => getOntology(db)),
  );

  server.registerTool(
    'search_knowledge',
    {
      title: 'Search knowledge',
      description: 'Full-text and fuzzy search across entity names, aliases, summaries and facts. Results are ranked with a nudge toward more trusted tiers.',
      inputSchema: {
        query: z.string().min(1),
        type: z.string().optional().describe('Only this entity type'),
        max_tier: tierSchema.optional().describe('Only entities at this tier or more trusted, e.g. 2 for Canon and Verified'),
        limit: z.number().int().min(1).max(50).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ query, type, max_tier, limit }) =>
      run(async () =>
        (await k.search(query, { type, maxTier: max_tier, limit })).map((e) => ({
          id: e.id,
          ref: `${e.type_key}:${e.name}`,
          tier: tierLabel(k, e.tier),
          owner: e.owner_name,
          summary: e.summary,
          matched_fact: e.matched_fact,
        })),
      ),
  );

  server.registerTool(
    'get_entity',
    {
      title: 'Get entity',
      description: 'An entity with its facts (grouped by tier), links to other entities, owner, and open request count.',
      inputSchema: { entity: entityRef, include_retracted: z.boolean().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ entity, include_retracted }) => run(async () => present(k, await k.getEntity(entity, { includeRetracted: include_retracted }))),
  );

  server.registerTool(
    'explore_graph',
    {
      title: 'Explore graph',
      description: 'The neighborhood around an entity, up to 3 hops, as nodes and edges.',
      inputSchema: { entity: entityRef, depth: z.number().int().min(1).max(3).optional(), relation_type: z.string().optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ entity, depth, relation_type }) =>
      run(async () => {
        const g = await k.neighbors(entity, { depth, relationType: relation_type });
        const names = new Map(g.nodes.map((n) => [n.id, `${n.type_key}:${n.name}`]));
        return {
          root: names.get(g.root),
          nodes: g.nodes.map((n) => ({ id: n.id, ref: `${n.type_key}:${n.name}`, tier: tierLabel(k, n.tier) })),
          edges: g.edges.map((e) => ({ relation_id: e.id, from: names.get(e.from_id), type: e.type_key, to: names.get(e.to_id), tier: tierLabel(k, e.tier) })),
        };
      }),
  );

  // ---------- write ----------

  server.registerTool(
    'create_entity',
    {
      title: 'Create entity',
      description: 'Create a new entity. You become its owner. Search first to avoid duplicates. If tier is omitted, it starts at the most trusted tier you are allowed to create.',
      inputSchema: {
        type: z.string().describe('Entity type key from get_ontology'),
        name: z.string().min(1),
        summary: z.string().optional(),
        aliases: z.array(z.string()).optional(),
        properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        tier: tierSchema.optional(),
        domain: z.string().optional().describe('Domain key; defaults to the type\'s domain'),
        owner_email: z.string().email().optional().describe('Admins and domain owners can assign someone else as owner'),
        source,
      },
    },
    async ({ source: src, ...input }) =>
      run(async () => {
        const e = await k.createEntity(actor, input, src ?? null);
        return { created: `${e.type_key}:${e.name}`, id: e.id, tier: tierLabel(k, e.tier), url: k.link(`/e/${e.id}`) };
      }),
  );

  server.registerTool(
    'update_entity',
    {
      title: 'Update entity',
      description: 'Change an entity\'s name, summary, aliases, properties or domain. Properties merge; set a key to null to remove it.',
      inputSchema: { entity: entityRef, changes: actionSchemas.update_entity, source },
    },
    async ({ entity, changes, source: src }) => change(entity, 'update_entity', changes, src),
  );

  server.registerTool(
    'add_observation',
    {
      title: 'Add fact',
      description: 'Attach a fact to an entity. Defaults to Working for people and your ceiling (usually Raw) for agents. A fact cannot be more trusted than its entity.',
      inputSchema: { entity: entityRef, content: z.string().min(1), tier: tierSchema.optional(), source },
    },
    async ({ entity, content, tier, source: src }) => change(entity, 'add_observation', tier ? { content, tier } : { content }, src),
  );

  server.registerTool(
    'relate',
    {
      title: 'Link entities',
      description: 'Create a typed link from one entity to another, e.g. person works_at organization. Relation types are in get_ontology.',
      inputSchema: { from: entityRef, type: z.string(), to: entityRef, tier: tierSchema.optional(), source },
    },
    async ({ from, type, to, tier, source: src }) => change(from, 'add_relation', tier ? { type, to, tier } : { type, to }, src),
  );

  server.registerTool(
    'change_knowledge',
    {
      title: 'Change knowledge',
      description: [
        'Other direct changes. Actions and payloads:',
        '  set_tier { tier, observation_id? } - promote or demote the entity, or one of its facts',
        '  retract_observation { observation_id }',
        '  remove_relation { relation_id }',
        '  deprecate_entity {}',
        '  transfer_ownership { new_owner: email }',
      ].join('\n'),
      inputSchema: {
        entity: entityRef,
        action: z.enum(['set_tier', 'retract_observation', 'remove_relation', 'deprecate_entity', 'transfer_ownership']),
        payload: z.record(z.string(), z.unknown()).default({}),
        source,
      },
      annotations: { destructiveHint: true },
    },
    async ({ entity, action, payload, source: src }) => change(entity, action, payload, src),
  );

  // ---------- curation ----------

  server.registerTool(
    'request_update',
    {
      title: 'Request update',
      description: [
        'Ask the owner to make a change you are not allowed to make directly, or that you want reviewed. The owner (or whoever can approve it) is pinged.',
        'Actions and payloads:',
        '  update_entity { name?, summary?, aliases?, properties?, domain? }',
        '  add_observation { content, tier? }   (tier defaults to the entity\'s tier)',
        '  retract_observation { observation_id }',
        '  add_relation { type, to, tier? }',
        '  remove_relation { relation_id }',
        '  set_tier { tier, observation_id? }',
        '  deprecate_entity {}',
        '  transfer_ownership { new_owner: email }',
      ].join('\n'),
      inputSchema: {
        entity: entityRef,
        action: z.enum(ACTIONS as [ActionKey, ...ActionKey[]]),
        payload: z.record(z.string(), z.unknown()).default({}),
        rationale: z.string().min(1).describe('Why this change is right. The owner reads this.'),
        source,
      },
    },
    async ({ entity, action, payload, rationale, source: src }) =>
      run(async () => {
        const r = await k.requestUpdate(actor, { entity, action, payload, rationale, source: src ?? null });
        const full = await k.getRequest(r.id);
        return { request_id: r.id, status: r.status, summary: r.summary, assigned_to: full.assignee_name, url: k.link(`/requests/${r.id}`) };
      }),
  );

  server.registerTool(
    'list_requests',
    {
      title: 'List requests',
      description: 'Change requests. box "assigned" is your review queue, "mine" is what you asked for, "all" is everyone\'s.',
      inputSchema: {
        box: z.enum(['assigned', 'mine', 'all']).default('assigned'),
        status: z.enum(['open', 'approved', 'rejected', 'withdrawn', 'any']).default('open'),
        entity: entityRef.optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ box, status, entity, limit }) =>
      run(async () => {
        const entityId = entity ? (await k.resolveEntity(db, entity)).id : undefined;
        return (await k.listRequests(actor, { box, status, entityId, limit })).map((r) => ({
          request_id: r.id,
          status: r.status,
          entity: `${r.entity_type}:${r.entity_name}`,
          action: r.action,
          summary: r.summary,
          payload: r.payload,
          rationale: r.rationale,
          source: r.source,
          requested_by: `${r.requested_by_name}${r.token_kind === 'agent' ? ` (agent: ${r.token_name})` : ''}`,
          assigned_to: r.assignee_name,
          resolution: r.status === 'open' ? undefined : { by: r.resolved_by_name, note: r.resolution_note, at: r.resolved_at },
          created_at: r.created_at,
        }));
      }),
  );

  server.registerTool(
    'curate_knowledge',
    {
      title: 'Curate knowledge',
      description:
        'Respond to a change request: approve it, approve with edits (fields in `edits` override the request payload), or reject it with a note. The requester is notified. You must be allowed to make the change yourself to approve it.',
      inputSchema: {
        request_id: z.string().uuid(),
        decision: z.enum(['approve', 'reject']),
        note: z.string().optional().describe('Shown to the requester'),
        edits: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) =>
      run(async () => {
        const r = await k.curate(actor, input);
        return {
          request_id: r.request.id,
          status: r.request.status,
          summary: r.request.summary,
          warning: r.stale ? 'The entity changed after this request was made. Double-check the result.' : undefined,
        };
      }),
  );

  server.registerTool(
    'withdraw_request',
    { title: 'Withdraw request', description: 'Withdraw one of your own open requests.', inputSchema: { request_id: z.string().uuid() } },
    async ({ request_id }) => run(async () => ({ request_id, status: (await k.withdraw(actor, request_id)).status })),
  );

  server.registerTool(
    'inbox',
    {
      title: 'Inbox',
      description: 'Your notifications: requests waiting on you, answers to your requests, and changes others made to knowledge you own.',
      inputSchema: { unread_only: z.boolean().default(true), mark_read: z.boolean().default(false) },
    },
    async ({ unread_only, mark_read }) =>
      run(async () => {
        const items = await listNotifications(db, actor.userId, { unreadOnly: unread_only, limit: 50 });
        if (mark_read && items.length) await markRead(db, actor.userId, items.map((n) => n.id));
        const waiting = await k.listRequests(actor, { box: 'assigned', status: 'open', limit: 1 });
        return {
          requests_waiting_on_you: waiting.length ? 'yes, call list_requests' : 'none',
          notifications: items.map((n) => ({ kind: n.kind, title: n.title, body: n.body, request_id: n.change_request_id, at: n.created_at, read: Boolean(n.read_at) })),
        };
      }),
  );

  // ---------- ontology ----------

  server.registerTool(
    'define_entity_type',
    {
      title: 'Define entity type',
      description: 'Create or replace an entity type and its property schema. Admins, or the owner of the type\'s domain. Human tokens only.',
      inputSchema: {
        key: z.string(),
        name: z.string(),
        description: z.string().optional(),
        default_tier: tierSchema.optional(),
        domain: z.string().optional(),
        properties: z
          .array(z.object({ key: z.string(), type: z.enum(['string', 'number', 'boolean', 'date', 'url', 'enum']), required: z.boolean().optional(), options: z.array(z.string()).optional(), description: z.string().optional() }))
          .optional(),
      },
    },
    async (input) => run(() => defineEntityType(db, actor, input)),
  );

  server.registerTool(
    'define_relation_type',
    {
      title: 'Define relation type',
      description: 'Create or replace a relation type. Admins only. Human tokens only.',
      inputSchema: {
        key: z.string(),
        name: z.string(),
        inverse_name: z.string().optional(),
        description: z.string().optional(),
        from_types: z.array(z.string()).optional(),
        to_types: z.array(z.string()).optional(),
      },
    },
    async (input) => run(() => defineRelationType(db, actor, input)),
  );

  return server;
}
