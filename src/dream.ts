import { config } from './config.js';
import { createPool } from './db.js';
import { runDream } from './dream/run.js';

const db = createPool(config.databaseUrl);
const stored = await db.query<{ value: string }>(`select value from app_settings where key = 'public_url'`);
const publicUrl = config.publicUrlIsSet ? config.publicUrl : (stored.rows[0]?.value ?? config.publicUrl);

const result = await runDream(db, {
  publicUrl,
  llm: config.dreamLlm,
  maxEntities: process.env.DREAM_MAX_ENTITIES ? Number(process.env.DREAM_MAX_ENTITIES) : undefined,
  maxRequests: process.env.DREAM_MAX_REQUESTS ? Number(process.env.DREAM_MAX_REQUESTS) : undefined,
});
console.log(JSON.stringify({ dream: result.runId, status: result.status, note: result.note, ...result.stats }));
await db.end();
process.exit(result.status === 'done' ? 0 : 1);
