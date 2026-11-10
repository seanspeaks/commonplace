# Commonplace

A shared knowledge graph for a team and its agents. Read and write it over MCP or in the browser, with trust tiers and owners deciding what counts as true.

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/seanspeaks/commonplace)

Every team I talk to is pointing agents at their docs, their CRM, their call transcripts, and asking them to remember stuff. The writing part works fine. The part nobody has really solved is who gets to decide what's true.

Commonplace lets anyone on the team, and any agent they connect, add to the same graph. But every fact has a trust tier and every entity has an owner, so an agent can't quietly turn its own guess into something sales repeats to a client. When it wants to change something it doesn't own, it files a request, the owner gets pinged, and they approve or reject it from the UI or from their own agent.

AI doesn't remove responsibility, it moves it around. This is me trying to make that explicit: agents propose, owners decide, and you can see who did what.

## Trust tiers

Every entity, fact and link sits on one of four tiers. Lower numbers are more trusted.

| Tier | Meant for | Who can change it |
|---|---|---|
| 1 Canon | Policies, commitments, the ontology itself | The owner |
| 2 Verified | Checked by someone who knows | The owner and the domain's curators |
| 3 Working | Team knowledge in active use | Any member |
| 4 Raw | Unreviewed. Where agents and imports land | Any member |

A few rules sit on top of that:

- **Owners can always overwrite their own knowledge.** Admins can too.
- **Promoting is different from editing.** Moving something into Canon takes the domain owner, and into Verified takes a curator. Owning an entity doesn't let you promote it.
- **Every token has a ceiling.** An agent token writes Raw by default, even on knowledge its own user owns. Anything above the ceiling becomes a request.
- **A fact can't be more trusted than its entity.** Demoting an entity demotes its facts.
- **Agents have to cite a source** on every write.

## Ownership and requests

```
agent: update_entity(Globex, relationship=client)
  -> refused: "This agent token can write Raw (tier 4) and below..."
     suggested_request_update: { entity, action, payload }

agent: request_update(..., rationale: "They signed the MSA, see thread-9")
  -> routed to the owner (or to someone who can approve it, e.g. the domain owner for a promotion)
  -> owner pinged in the UI, in their MCP inbox, and on their webhook (Slack works as-is)

owner: curate_knowledge(request_id, approve | reject, note?, edits?)
  -> change applied, credited to the requester, requester notified
```

If the entity changed after the request was filed, the approval still works but comes with a warning to double-check.

## Ontology

Entity types have property schemas (string, number, boolean, date, url, enum), a default tier and a domain. Relation types can restrict which types they connect. Domains group ownership: each has an owner and curators. A starter ontology (person, organization, project, decision, policy, topic, document) is created on first boot. Change it on the Ontology page or with the `define_entity_type` and `define_relation_type` tools. Only people can change the ontology, not agents.

## Deploy to Render

1. Click **Deploy to Render** above. The Blueprint creates a web service and a private Postgres database.
2. Set `ADMIN_EMAIL`. `ADMIN_TOKEN` is generated for you.
3. Open the service, copy `ADMIN_TOKEN` from the Environment tab and sign in with it.
4. Add your team under **Settings**. Each person gets a sign-in token.

Migrations run in the pre-deploy step and again on boot, which is a no-op if nothing changed.

## Connect an agent

Create an **agent** token under Settings, then:

```bash
claude mcp add --transport http commonplace https://YOUR-SERVICE.onrender.com/mcp \
  --header "Authorization: Bearer cp_..."
```

For Cursor and other clients that take JSON config:

```json
{
  "mcpServers": {
    "commonplace": {
      "url": "https://YOUR-SERVICE.onrender.com/mcp",
      "headers": { "Authorization": "Bearer cp_..." }
    }
  }
}
```

The server sends instructions to the agent explaining the tiers and when to use `request_update`.

## MCP tools

| Tool | What it does |
|---|---|
| `whoami` | Your role, token kind and write ceiling |
| `get_ontology` | Tiers, domains, entity types and relation types |
| `search_knowledge` | Full-text and fuzzy search over names, aliases, summaries and facts. Filter by type or trust |
| `get_entity` | An entity with its facts by tier, links, owner and open requests |
| `explore_graph` | The neighborhood around an entity, up to 3 hops |
| `create_entity` | New entity. You own it |
| `update_entity` | Change name, summary, aliases, properties or domain |
| `add_observation` | Add a fact to an entity |
| `relate` | Link two entities with a typed relation |
| `change_knowledge` | Set tier, retract a fact, remove a link, deprecate, transfer ownership |
| `request_update` | Ask the owner to make a change |
| `list_requests` | Your review queue, your requests, or everyone's |
| `curate_knowledge` | Approve, approve with edits, or reject a request |
| `withdraw_request` | Pull back one of your requests |
| `inbox` | Your notifications |
| `define_entity_type`, `define_relation_type` | Change the ontology (people only) |

## Run it locally

```bash
docker compose up -d          # Postgres on :54329
cp .env.example .env          # then edit ADMIN_EMAIL and ADMIN_TOKEN
npm install
set -a; source .env; set +a
npm run seed:demo             # optional: a small graph with a pending agent request
npm run dev                   # http://localhost:3000
```

## Tests

```bash
docker compose up -d
npm test
```

The tests run against a real Postgres and create a throwaway database for each file. They cover the policy engine, the request and curation flow, ontology enforcement, search, MCP end to end over HTTP with the SDK client, webhook delivery and the UI's sign-in and request fallback.

## How it's built

- **One Node service** (Express + the MCP TypeScript SDK) serves the MCP endpoint, the UI and the health check. The UI is server-rendered HTML, so there's no frontend build step.
- **Stateless Streamable HTTP.** Each MCP request gets a fresh server bound to the caller's identity, so any instance can serve any request and you can scale out without sticky sessions.
- **Postgres is the graph.** Entities, facts and relations are tables, traversal is a recursive CTE, search is `tsvector` plus `pg_trgm`. No separate graph database to run.
- **One policy function** (`src/policy.ts`) decides every write, whether it comes from MCP or the UI.
- **Notifications double as an outbox.** A dispatcher in the web process pushes pending pings to webhooks with retries.
- **Everything is audited.** Every change records who made it and whether it came from a person or an agent token.

## Roadmap

- Hybrid search with `pgvector` embeddings
- OAuth 2.1 so it works as a custom connector in Claude.ai and Claude Desktop
- Ingestion from meeting transcripts, email and tickets as Render Workflows, landing as Raw facts with sources
- A nightly cron job that flags likely duplicates, orphans and stale facts for review

## License

MIT
