import type { Queryable } from '../db.js';

export interface AuditEntry {
  actorId: string;
  tokenId: string | null;
  action: string;
  targetKind: 'entity' | 'observation' | 'relation' | 'request' | 'ontology' | 'user' | 'token';
  targetId: string | null;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await db.query(
    `insert into events (actor_id, token_id, action, target_kind, target_id, entity_id, before, after)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [e.actorId, e.tokenId, e.action, e.targetKind, e.targetId, e.entityId ?? null, json(e.before), json(e.after)],
  );
}

function json(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}
