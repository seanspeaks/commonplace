import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrator.js';
import { startDispatcher } from './services/notify.js';

const db = createPool(config.databaseUrl);
await migrate(db);
await bootstrap(db, config);

const { app } = await createApp(db, { publicUrl: config.publicUrl });
const stopDispatcher = startDispatcher(db, config.notifyWebhookUrl);
const server = app.listen(config.port, () => {
  console.log(`Commonplace listening on :${config.port}. UI at ${config.publicUrl}, MCP at ${config.publicUrl}/mcp`);
});

process.on('SIGTERM', () => {
  stopDispatcher();
  server.close(() => void db.end().then(() => process.exit(0)));
});
