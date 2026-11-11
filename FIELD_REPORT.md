# Field report: building Commonplace on Render

A running log of what helped and what got in the way while building this. Everything below "Before first deploy" came from the docs and a local build. The deploy section gets filled in once it's live.

## Before first deploy

### Worked well

- **Docs as markdown.** Every docs page is also served at `.md`, plus `/llms.txt`. My coding agent scraped the HTML pages first and got mostly nav. The `.md` versions were clean, so I'd make that easier to find (a `<link rel="alternate" type="text/markdown">` on each page would let agents discover it on their own).
- **Blueprint basics covered what I needed.** `ipAllowList: []` for a Postgres that's only on the private network, `generateValue: true` for the first admin token, and `preDeployCommand` for migrations.
- **The MCP hosting guide matches what I built.** Stateless Streamable HTTP, scale out with no sticky sessions, state in Postgres.

### Friction

1. **`sslmode=require` on the internal URL breaks node-postgres.** The Postgres docs say internal connections support TLS with self-signed certs and suggest `sslmode=require` to avoid plaintext fallback. In `pg` 8.x (`pg-connection-string` 2.14.1 here), `require` is treated as `verify-full`, which fails on a self-signed cert. You need `uselibpqcompat=true&sslmode=require`, or `ssl: { rejectUnauthorized: false }` in code. A Node callout on that page would save people a confusing error.

2. **Plan names.** The Blueprint spec now uses CPU/RAM IDs (`0.5c-512mb`, `0.1c-256mb`). Older examples, and most of what coding agents learned from, say `plan: starter`. I couldn't find whether the old names still validate. One line in the spec would settle it.

3. **No graph extension in Postgres.** Apache AGE isn't on the supported extension list. Recursive CTEs were plenty at team scale, and it keeps the stack to one database. The knowledge graph templates in the gallery (Graphiti, Neo4j Context Graph) bring a separate graph database, so a "graph on plain Render Postgres" guide might be useful.

4. **`preDeployCommand` is paid-only.** On a free instance migrations have to run at boot. I run them in both places. A note in the Blueprint spec next to the field would help people deploying a template on the free tier.

5. **MCP auth beyond bearer tokens.** The templates use bearer tokens and the guide says to put OAuth 2.1 in front of production clients, ideally through a managed IdP. For a team tool that wants to show up as a Claude.ai connector without adding another vendor, an example authorization server backed by Render Postgres (with dynamic client registration) would close the gap. It's next on this project's roadmap.

### To check

- The MCP hosting guide's FAQ says Cursor refuses servers that don't expose OAuth discovery. Cursor and Claude Code both take static `Authorization` headers in config, which is how Commonplace connects. I'll confirm with Cursor on first deploy before suggesting a doc change.

## First deploy

- [x] Blueprint validates with `0.5c-512mb` and `0.1c-256mb`
- [x] Pre-deploy migration runs, then the boot migration is a no-op
- [x] Notification links use `RENDER_EXTERNAL_URL`
- [ ] Claude Code and Cursor connect with a bearer header (MCP verified over raw HTTP, clients still to do)
- [ ] Two instances serve MCP traffic without sessions
- [x] Time from push to healthy: about 30s from build start to live on the first deploy, about 60s for a redeploy

### Found on deploy

6. **A blank `sync: false` var deploys anyway.** I left `ADMIN_EMAIL` empty on the Blueprint screen and everything went green, but the app couldn't create its first admin, so nobody could sign in. The only sign was a log line. There's no way in the spec to mark a `sync: false` value as required. Something like `required: true` would catch it before the first deploy. On my side, the sign-in page should say so too.

7. **A quick second push shows up as "canceled".** I pushed twice within a few seconds, and the first deploy shows as canceled in the dashboard, which looked like a failure at first. It's the right behavior, but saying it was "superseded by a newer commit" would read less like an error.
