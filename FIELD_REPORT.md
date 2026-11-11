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

5. **MCP auth beyond bearer tokens.** The templates use bearer tokens and the guide says to put OAuth 2.1 in front of production clients, ideally through a managed IdP. For a team tool that wants to show up as a Claude.ai connector without adding another vendor, an example authorization server backed by Render Postgres (with dynamic client registration) would close the gap. Commonplace now has one (see "Adding OAuth" below).

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

## Adding OAuth

Optional MCP auth, on with `OAUTH_ENABLED=true`. It's the MCP SDK's auth router plus about 300 lines that keep clients, codes and tokens in the same Postgres, so no IdP to sign up for. Approved connections are agent tokens with a ceiling picked on the consent page, so they show up under Settings next to everything else.

- [x] Discovery live: the 401 points at protected resource metadata, which points at the authorization server metadata
- [x] Dynamic client registration, authorize, consent behind sign-in
- [x] Existing bearer tokens unaffected (17 tools over the same endpoint)
- [ ] Full sign-in from Claude.ai and ChatGPT custom connectors

### Worked well

8. **`RENDER_EXTERNAL_URL` is already https.** OAuth issuers have to be https, and the SDK refuses to start otherwise. On Render the issuer came for free with no custom domain and no `PUBLIC_URL` to set, which is a nice thing to point out in the MCP hosting guide.

9. **Blueprint sync picked up a new env var on push.** I added `OAUTH_ENABLED: "true"` to `render.yaml` on a running service and pushed. The sync added the var and the deploy that followed came up with OAuth on, no dashboard step. I didn't expect it to. If the Blueprint docs don't spell it out, they should, since it's how a template ships a new feature flag to everyone who already deployed it.

## Adding recall hooks and a nightly cron

Recall puts what the graph knows in front of an agent on every prompt (a Claude Code hook plus a `recall` tool). The nightly "dream" is a cron job that learns from recall and lists housekeeping, and with an inference provider writes digests and files change requests for owners. It runs fine with no provider at all.

- [x] Cron job created by a Blueprint sync on push, built and ran
- [x] Triggered by API, ran in about a second with no provider, one ledger row per run
- [x] Recall and the hook endpoint live, 18 tools over the same endpoint
- [ ] A night with an inference provider on Render

### Worked well

10. **Adding a cron job was one block of YAML and a push.** The sync created `commonplace-dream`, built it from the same repo and attached the same database with `fromDatabase`. Billing per second suits a job that usually finishes in a second. Later triggered runs started straight away without rebuilding.

### Friction

11. **A new service from a sync doesn't prompt for its `sync: false` vars.** The docs say updates to an existing Blueprint ignore `sync: false`, and that's what happened, but here the cron job itself was brand new. Its three optional inference vars just didn't appear. Fine for optional ones, but a required secret on a new service would fail quietly, which is the same trap as item 6. Prompting for `sync: false` vars on any service the sync creates would cover it.

12. **Cron jobs don't know the web service's public URL.** The dream files change requests whose notifications link back to the UI, and a cron job has no `RENDER_EXTERNAL_URL`. I have the web service write its URL to the database at boot and the cron job read it. `fromService` with `envVarKey: RENDER_EXTERNAL_HOSTNAME` is documented for a service referencing itself; I haven't tried it across services.

13. **No way to read a cron run's result over the API that I found.** `POST /v1/cron-jobs/{id}/runs` triggers a run, but `GET` on the same path returns 405, so I read the outcome from the logs API. A run status endpoint would make "trigger and wait" scriptable, which is how I'd want to test a cron job in CI.

### To check

- Whether `fromService` can pass a web service's `RENDER_EXTERNAL_HOSTNAME` to a cron job. If it can, item 12 is a docs example, not a gap.
