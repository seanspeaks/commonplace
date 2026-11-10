import { z } from 'zod';
import type { Db, Queryable } from '../db.js';
import { forbidden, invalid, notFound } from '../errors.js';
import { generateToken, hashToken, tokenPrefix } from '../auth.js';
import type { Actor, TierRank } from '../types.js';
import { audit } from './audit.js';
import { parse } from './knowledge.js';

export const newUserInput = z
  .object({ email: z.string().email(), name: z.string().min(1), role: z.enum(['admin', 'member']).default('member') })
  .strict();

export const newTokenInput = z
  .object({
    name: z.string().min(1).max(100),
    kind: z.enum(['human', 'agent']),
    ceiling_tier: z.number().int().min(1).max(4).optional(),
  })
  .strict()
  .transform((t) => ({ ...t, ceiling_tier: (t.ceiling_tier ?? (t.kind === 'agent' ? 4 : 1)) as TierRank }))
  .refine((t) => t.kind === 'human' || t.ceiling_tier >= 2, 'Agent tokens cannot write Canon; pick a ceiling of 2, 3 or 4');

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  notify_webhook_url: string | null;
  created_at: Date;
}

export interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  kind: 'human' | 'agent';
  ceiling_tier: TierRank;
  prefix: string;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Date;
}

function requireHuman(actor: Actor) {
  if (actor.tokenKind !== 'human') throw forbidden('Agents cannot manage users or tokens');
}

export async function listUsers(db: Queryable): Promise<UserRow[]> {
  return (await db.query<UserRow>('select * from users order by name')).rows;
}

export async function createUser(db: Db, actor: Actor, raw: unknown): Promise<{ user: UserRow; token: string }> {
  requireHuman(actor);
  if (actor.role !== 'admin') throw forbidden('Only admins can add people');
  const input = parse(newUserInput, raw, 'user');
  const exists = await db.query('select 1 from users where email = $1', [input.email]);
  if (exists.rowCount) throw invalid(`${input.email} already has an account`);
  const { rows } = await db.query<UserRow>('insert into users (email, name, role) values ($1, $2, $3) returning *', [input.email, input.name, input.role]);
  const token = await insertToken(db, rows[0].id, { name: 'First login', kind: 'human', ceiling_tier: 1 });
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'user.create', targetKind: 'user', targetId: rows[0].id, after: { email: input.email, role: input.role } });
  return { user: rows[0], token };
}

export async function setRole(db: Db, actor: Actor, userId: string, role: 'admin' | 'member'): Promise<void> {
  requireHuman(actor);
  if (actor.role !== 'admin') throw forbidden('Only admins can change roles');
  if (userId === actor.userId && role !== 'admin') throw invalid("You can't remove your own admin role");
  await db.query('update users set role = $2 where id = $1', [userId, role]);
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'user.role', targetKind: 'user', targetId: userId, after: { role } });
}

export async function setWebhook(db: Db, actor: Actor, url: string | null): Promise<void> {
  if (url && !URL.canParse(url)) throw invalid('Webhook must be a valid URL');
  await db.query('update users set notify_webhook_url = $2 where id = $1', [actor.userId, url || null]);
}

async function insertToken(db: Queryable, userId: string, t: { name: string; kind: 'human' | 'agent'; ceiling_tier: TierRank }): Promise<string> {
  const raw = generateToken();
  await db.query(`insert into api_tokens (user_id, name, kind, ceiling_tier, token_hash, prefix) values ($1, $2, $3, $4, $5, $6)`, [
    userId,
    t.name,
    t.kind,
    t.ceiling_tier,
    hashToken(raw),
    tokenPrefix(raw),
  ]);
  return raw;
}

export async function createToken(db: Db, actor: Actor, raw: unknown): Promise<string> {
  requireHuman(actor);
  const input = parse(newTokenInput, raw, 'token');
  const token = await insertToken(db, actor.userId, input);
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'token.create', targetKind: 'token', targetId: null, after: { name: input.name, kind: input.kind, ceiling_tier: input.ceiling_tier } });
  return token;
}

export async function listTokens(db: Queryable, userId: string): Promise<TokenRow[]> {
  return (
    await db.query<TokenRow>(
      'select id, user_id, name, kind, ceiling_tier, prefix, last_used_at, revoked_at, created_at from api_tokens where user_id = $1 order by created_at desc',
      [userId],
    )
  ).rows;
}

export async function revokeToken(db: Db, actor: Actor, tokenId: string): Promise<void> {
  requireHuman(actor);
  const result = await db.query(
    `update api_tokens set revoked_at = now() where id = $1 and revoked_at is null and (user_id = $2 or $3)`,
    [tokenId, actor.userId, actor.role === 'admin'],
  );
  if (!result.rowCount) throw notFound('No active token with that id');
  await db.query('delete from sessions where token_id = $1', [tokenId]);
  await audit(db, { actorId: actor.userId, tokenId: actor.tokenId, action: 'token.revoke', targetKind: 'token', targetId: tokenId });
}
