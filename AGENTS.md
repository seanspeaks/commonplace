# Notes for coding agents

- Node 22+, TypeScript, ESM. `npm run typecheck`, `npm test` (needs `docker compose up -d` for Postgres on :54329).
- Every write goes through `canWrite` in `src/policy.ts`. Don't add a write path that skips it; add a new action to `prepare`/`apply` in `src/services/knowledge.ts` instead, so direct writes, requests and approvals all share it.
- MCP tools live in `src/mcp/server.ts` and should stay thin: parse input, call the service, shape the output.
- Schema changes are new files in `migrations/` (never edit an applied one).
- The UI is server-rendered with the `html` tagged template in `src/ui/html.ts`, which escapes interpolations. Use `raw()` only for trusted strings.
- Tests hit a real database; prefer adding to `test/curation.test.ts` or `test/mcp.test.ts` over mocking.
