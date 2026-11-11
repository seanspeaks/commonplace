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

1. Click **Deploy to Render** above. The Blueprint creates a web service, a private Postgres database and the nightly dream cron job.
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

### Or connect with OAuth

With `OAUTH_ENABLED=true` (the Blueprint turns it on) you don't need a token. Add `https://YOUR-SERVICE.onrender.com/mcp` as a custom connector in Claude.ai, ChatGPT, Cursor or anything else that speaks MCP auth. You'll get sent to Commonplace, sign in, and pick the highest tier the app can write directly. Above that it files requests like any other agent.

Each approved app shows up under Settings as an agent token named after the app, so revoking it there disconnects it right away. Access tokens last an hour, refresh tokens rotate, and if an old refresh token ever comes back the whole connection gets revoked.

It follows the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization): protected resource metadata, authorization server metadata, dynamic client registration, PKCE (S256 only) and resource indicators. Client secrets and tokens are stored hashed. Plain tokens from Settings keep working alongside it.

### Hooks: context without asking

Agents only check the graph when they think to. [Claude Code hooks](https://code.claude.com/docs/en/hooks) fix that: a short briefing when a session starts (who you are, what's waiting on you, anything matching the project folder), then the entities each prompt is clearly about, with their most trusted facts.

```json
{
  "hooks": {
    "SessionStart": [{ "hooks": [{
      "type": "http",
      "url": "https://YOUR-SERVICE.onrender.com/hooks/claude-code",
      "headers": { "Authorization": "Bearer $COMMONPLACE_TOKEN" },
      "allowedEnvVars": ["COMMONPLACE_TOKEN"],
      "timeout": 10
    }] }],
    "UserPromptSubmit": [{ "hooks": [{
      "type": "mcp_tool",
      "server": "commonplace",
      "tool": "recall",
      "input": { "text": "${prompt}" },
      "timeout": 10
    }] }]
  }
}
```

The prompt hook calls the `recall` tool through the MCP connection you already set up, so it works with OAuth too. SessionStart has to be HTTP since MCP servers aren't connected yet when it fires. `/hooks/claude-code` also answers `UserPromptSubmit` if you'd rather use one token for both.

Recall stays quiet unless an entity is named in the prompt or matches several of its keywords, so most prompts add nothing. It logs which entities it handed to whom, never the prompt. Other clients get the same thing by calling `recall` at the start of a task, which the server's instructions tell them to do.

## MCP tools

| Tool | What it does |
|---|---|
| `whoami` | Your role, token kind and write ceiling |
| `recall` | Paste a prompt or task, get back the few entities it's about as plain text. Built for hooks |
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

## The nightly dream

A cron job that goes over the graph once a night, at 09:00 UTC on Render. It has two halves.

**Always on, no model needed.** It works out which recalled entities people actually used (wrote to or asked about within the hour) and which they ignored, and nudges recall ranking toward the useful ones. It also lists likely duplicates, empty entities, Raw facts nobody has looked at in 30 days and requests that have waited more than a week. That runs in a few seconds.

**Optional, with an inference provider.** Set `DREAM_LLM_BASE_URL`, `DREAM_LLM_MODEL` and `DREAM_LLM_API_KEY` on the cron job (anything OpenAI-compatible: OpenAI, OpenRouter, Together, Groq, a local Ollama...) and it also reads each entity that got new facts that day. For each one it:

- writes a short digest that recall shows next to the facts
- asks the owner to retract facts a newer fact replaced
- flags facts that disagree
- drafts a summary for entities that don't have one

The rules it follows:

- **It proposes, it never applies.** It acts as its own agent with a Raw ceiling, so everything goes to owners as a change request. Nothing changes until someone approves it.
- **A digest is only as trusted as its weakest source.** Every sentence has to cite facts on that entity. Sentences that cite nothing real are dropped, and the digest is labeled with the tier of the least trusted fact it cites.
- **Facts are data.** The model is told to ignore instructions inside them, and since its output is only ever a proposal, a poisoned fact can't promote itself.
- **Every night leaves a record.** One ledger row per run, including failures and nights with no provider, on the **Dream** page with the latest findings.

`DREAM_MAX_ENTITIES` (default 12) and `DREAM_MAX_REQUESTS` (default 10) cap a night. Run it by hand with `npm run dream:dev`, or **Trigger Run** on the cron job in Render.

This leans on a few people's work: the "propose, don't promote" loop and the ledger from rUv's [Dream Machine](https://github.com/ruvnet/dream-machine) and the feedback-tuned retrieval in [AgentDB](https://github.com/ruvnet/agentdb), [sleep-time compute](https://arxiv.org/abs/2504.13171) for doing the work before anyone asks, [authority collapse](https://arxiv.org/abs/2608.01679) for keeping a consolidated memory from claiming more trust than its sources, [TrustMem](https://arxiv.org/abs/2606.25161) for checking every memory update against what it came from, and [MemLACE](https://arxiv.org/abs/2609.03201) for treating supersession and contradiction as first-class.

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

The tests run against a real Postgres and create a throwaway database for each file. They cover the policy engine, the request and curation flow, ontology enforcement, search, MCP end to end over HTTP with the SDK client, webhook delivery, the UI's sign-in and request fallback, the OAuth flow (including the SDK's own OAuth client doing discovery, registration and PKCE against it), recall and the Claude Code hook endpoint, and the dream with and without a provider. The provider is the one thing faked: a local server that speaks the OpenAI chat API.

## How it's built

- **One Node service** (Express + the MCP TypeScript SDK) serves the MCP endpoint, the UI and the health check. The UI is server-rendered HTML, so there's no frontend build step.
- **Stateless Streamable HTTP.** Each MCP request gets a fresh server bound to the caller's identity, so any instance can serve any request and you can scale out without sticky sessions.
- **Postgres is the graph.** Entities, facts and relations are tables, traversal is a recursive CTE, search is `tsvector` plus `pg_trgm`. No separate graph database to run.
- **One policy function** (`src/policy.ts`) decides every write, whether it comes from MCP or the UI.
- **Notifications double as an outbox.** A dispatcher in the web process pushes pending pings to webhooks with retries.
- **Everything is audited.** Every change records who made it and whether it came from a person or an agent token.

## Roadmap

- Hybrid search with `pgvector` embeddings
- Client ID metadata documents, so clients can skip dynamic registration
- Ingestion from meeting transcripts, email and tickets as Render Workflows, landing as Raw facts with sources
- A merge action, so the dream's duplicate findings can become requests too
- Hook recipes for Cursor, Codex and other agents as they add context hooks

## License

MIT
