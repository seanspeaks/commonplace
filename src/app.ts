import express, { type NextFunction, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { actorFromToken } from './auth.js';
import type { Db } from './db.js';
import { AppError } from './errors.js';
import { buildMcpServer } from './mcp/server.js';
import { Knowledge } from './services/knowledge.js';
import { uiRouter } from './ui/routes.js';

export async function createApp(db: Db, opts: { publicUrl: string }) {
  const k = await Knowledge.create(db, opts.publicUrl);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.get('/healthz', async (_req, res) => {
    await db.query('select 1');
    res.json({ ok: true });
  });

  // Stateless Streamable HTTP: every request gets a fresh server bound to the caller's identity,
  // so any instance behind Render's load balancer can serve any request.
  app.post('/mcp', express.json({ limit: '2mb' }), async (req, res) => {
    const header = req.get('authorization') ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    const actor = token ? await actorFromToken(db, token) : null;
    if (!actor) {
      res.set('WWW-Authenticate', 'Bearer realm="commonplace"').status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Missing or invalid token. Create one under Settings and send it as "Authorization: Bearer <token>".' },
        id: null,
      });
      return;
    }
    const server = buildMcpServer(k, actor);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null });
  });

  app.use(uiRouter(k));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      const status = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409, unauthorized: 401 }[err.code];
      res.status(status).type('text').send([err.message, err.hint].filter(Boolean).join('\n'));
      return;
    }
    console.error(`${req.method} ${req.path} failed:`, err);
    res.status(500).type('text').send('Something went wrong.');
  });

  return { app, knowledge: k };
}
