import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrator.js';
import { bootstrap } from './bootstrap.js';

const db = createPool(config.databaseUrl);
const ran = await migrate(db);
console.log(ran.length ? `Applied migrations: ${ran.join(', ')}` : 'Database is up to date');
await bootstrap(db, config);
await db.end();
