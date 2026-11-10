import { readdir, readFile } from 'node:fs/promises';
import type { Db } from './db.js';

const migrationsDir = new URL('../migrations/', import.meta.url);

export async function migrate(db: Db): Promise<string[]> {
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await db.query<{ name: string }>('select name from schema_migrations')).rows.map((r) => r.name));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(new URL(file, migrationsDir), 'utf8');
    const client = await db.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(424242)');
      const again = await client.query('select 1 from schema_migrations where name = $1', [file]);
      if (again.rowCount === 0) {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [file]);
        ran.push(file);
      }
      await client.query('commit');
    } catch (err) {
      await client.query('rollback');
      throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
