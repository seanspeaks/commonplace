import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { actorFromToken, generateToken, hashToken, tokenPrefix } from '../src/auth.js';
import { bootstrap } from '../src/bootstrap.js';
import { createPool, type Db } from '../src/db.js';
import { migrate } from '../src/migrator.js';
import { Knowledge } from '../src/services/knowledge.js';
import type { Actor, TierRank } from '../src/types.js';

const ADMIN_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/postgres';

export interface TestEnv {
  db: Db;
  k: Knowledge;
  adminToken: string;
  admin: Actor;
  url: string;
  addUser(email: string, opts?: { role?: 'admin' | 'member' }): Promise<{ id: string; token: string; actor: Actor }>;
  addToken(userId: string, kind: 'human' | 'agent', ceiling: TierRank): Promise<{ token: string; actor: Actor }>;
  refresh(token: string): Promise<Actor>;
  close(): Promise<void>;
}

export async function setup(): Promise<TestEnv> {
  const name = `commonplace_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`create database ${name}`);
  await admin.end();

  const url = ADMIN_URL.replace(/\/[^/]*$/, `/${name}`);
  const db = createPool(url);
  await migrate(db);
  const adminToken = generateToken();
  await bootstrap(db, { adminEmail: 'admin@example.com', adminToken });
  const k = await Knowledge.create(db, 'http://test.local');

  const refresh = async (token: string) => {
    const actor = await actorFromToken(db, token);
    if (!actor) throw new Error('token did not resolve');
    return actor;
  };

  const addToken = async (userId: string, kind: 'human' | 'agent', ceiling: TierRank) => {
    const token = generateToken();
    await db.query(`insert into api_tokens (user_id, name, kind, ceiling_tier, token_hash, prefix) values ($1, $2, $3, $4, $5, $6)`, [
      userId,
      `${kind} token`,
      kind,
      ceiling,
      hashToken(token),
      tokenPrefix(token),
    ]);
    return { token, actor: await refresh(token) };
  };

  return {
    db,
    k,
    adminToken,
    admin: await refresh(adminToken),
    url,
    refresh,
    addToken,
    async addUser(email, opts = {}) {
      const { rows } = await db.query<{ id: string }>(`insert into users (email, name, role) values ($1, $2, $3) returning id`, [
        email,
        email.split('@')[0],
        opts.role ?? 'member',
      ]);
      const { token, actor } = await addToken(rows[0].id, 'human', 1);
      return { id: rows[0].id, token, actor };
    },
    async close() {
      await db.end();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`drop database if exists ${name} with (force)`);
      await c.end();
    },
  };
}
