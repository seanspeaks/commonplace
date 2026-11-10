import pg from 'pg';

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  // Render's external URL requires TLS. The internal URL (private network) makes it optional, with
  // self-signed certs, which node-postgres rejects under sslmode=require, so we leave it off there.
  const external = connectionString.includes('.render.com');
  return new pg.Pool({ connectionString, max: 10, ssl: external ? { rejectUnauthorized: false } : undefined });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
