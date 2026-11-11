import { createApp } from './app.js';
import { bootstrap } from './bootstrap.js';
import { config } from './config.js';
import { createPool } from './db.js';
import { migrate } from './migrator.js';
import { startDispatcher } from './services/notify.js';

const db = createPool(config.databaseUrl);
await migrate(db);
await bootstrap(db, config);
// The nightly dream runs as a cron job with no public URL of its own and reads this to build links.
await db.query(
  `insert into app_settings (key, value) values ('public_url', $1) on conflict (key) do update set value = excluded.value, updated_at = now()`,
  [config.publicUrl],
);

const { app } = await createApp(db, { publicUrl: config.publicUrl, oauth: config.oauthEnabled });
const stopDispatcher = startDispatcher(db, config.notifyWebhookUrl);
const server = app.listen(config.port, () => {
  console.log(
    `Commonplace listening on :${config.port}. UI at ${config.publicUrl}, MCP at ${config.publicUrl}/mcp, OAuth ${config.oauthEnabled ? 'on' : 'off'}`,
  );
});

process.on('SIGTERM', () => {
  stopDispatcher();
  server.close(() => void db.end().then(() => process.exit(0)));
});
