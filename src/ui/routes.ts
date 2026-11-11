import express, { type NextFunction, type Request, type Response } from 'express';
import { actorFromSession, actorFromToken, createSession, destroySession } from '../auth.js';
import { AppError } from '../errors.js';
import { approvePending, denyPending, getPending } from '../oauth.js';
import { ACTIONS, type EntityDetail, type Knowledge, type RequestListRow } from '../services/knowledge.js';
import { listNotifications, markRead } from '../services/notify.js';
import { createDomain, defineEntityType, defineRelationType, getOntology, setCurator } from '../services/ontology.js';
import { createToken, createUser, listTokens, listUsers, revokeToken, setRole, setWebhook } from '../services/users.js';
import type { ActionKey, Actor, EntityTypeRow, TierRank } from '../types.js';
import { createHash } from 'node:crypto';
import { CSS, html, Html, raw, timeAgo } from './html.js';

const COOKIE = 'cp_session';
const CSS_PATH = `/static/app.${createHash('sha256').update(CSS).digest('hex').slice(0, 10)}.css`;

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor;
  }
}

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

type Body = Record<string, string | undefined>;
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
/** Only same-site paths, so a crafted login link can't bounce someone to another origin. */
const safeNext = (v?: string) => (v && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') ? v : '/');

export function uiRouter(k: Knowledge): express.Router {
  const r = express.Router();
  const db = k.db;
  r.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // ---------- helpers ----------

  const tierBadge = (rank: TierRank) => html`<span class="badge tier-${rank}" title="Tier ${rank}">${k.tierName(rank)}</span>`;
  const statusBadge = (s: string) => html`<span class="badge status-${s}">${s}</span>`;
  const agentBadge = (kind: string | null) => (kind === 'agent' ? html` <span class="badge agent">agent</span>` : '');
  const entityLink = (id: string, label: string) => html`<a href="/e/${id}">${label}</a>`;
  const tierOptions = (selected?: number, blank?: string) =>
    html`${blank ? html`<option value="">${blank}</option>` : ''}${[...k.tiers.values()].map(
      (t) => html`<option value="${t.rank}" ${t.rank === selected ? 'selected' : ''}>${t.rank} · ${t.name}</option>`,
    )}`;

  async function counts(actor: Actor) {
    const { rows } = await db.query<{ waiting: string; unread: string }>(
      `select (select count(*) from change_requests where assignee_id = $1 and status = 'open') as waiting,
              (select count(*) from notifications where user_id = $1 and read_at is null) as unread`,
      [actor.userId],
    );
    return { waiting: Number(rows[0].waiting), unread: Number(rows[0].unread) };
  }

  async function page(res: Response, actor: Actor | undefined, title: string, body: Html, opts: { flash?: string; error?: string; status?: number } = {}) {
    const c = actor ? await counts(actor) : null;
    const flash = opts.flash ?? str(res.req.query.msg);
    const error = opts.error ?? str(res.req.query.err);
    res.status(opts.status ?? 200).type('html').send(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <title>${title} · Commonplace</title>
            <link rel="stylesheet" href="${CSS_PATH}" />
          </head>
          <body>
            <header class="top">
              <div class="bar">
                <a class="brand" href="/">Commonplace</a>
                ${actor
                  ? html`<nav>
                        <a href="/search">Search</a>
                        <a href="/requests">Requests${c && c.waiting ? html` <span class="badge status-open">${c.waiting}</span>` : ''}</a>
                        <a href="/ontology">Ontology</a>
                        <a href="/activity">Activity</a>
                        <a href="/settings">Settings</a>
                      </nav>
                      <span class="who">${actor.name}${actor.role === 'admin' ? ' · admin' : ''}${c && c.unread ? html` · <a href="/">${c.unread} new</a>` : ''}</span>
                      <form class="inline" method="post" action="/logout"><button>Sign out</button></form>`
                  : ''}
              </div>
            </header>
            <main>
              ${flash ? html`<div class="flash">${flash}</div>` : ''} ${error ? html`<div class="flash error">${error}</div>` : ''} ${body}
            </main>
          </body>
        </html>`.value,
    );
  }

  const back = (res: Response, path: string, msg?: string, err?: string) => {
    const params = new URLSearchParams();
    if (msg) params.set('msg', msg);
    if (err) params.set('err', err);
    res.redirect(303, params.size ? `${path}?${params}` : path);
  };

  const errorText = (err: unknown) => (err instanceof AppError ? [err.message, err.hint].filter(Boolean).join(' ') : 'Something went wrong.');

  // ---------- static, auth ----------

  r.get(CSS_PATH, (_req, res) => {
    res.type('css').set('cache-control', 'public, max-age=31536000, immutable').send(CSS);
  });

  r.use(async (req, _res, next) => {
    const sid = cookies(req)[COOKIE];
    if (sid) req.actor = (await actorFromSession(db, sid)) ?? undefined;
    next();
  });

  // Session cookies are SameSite=Lax; also require same-origin POSTs.
  r.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const origin = req.get('origin') ?? req.get('referer');
    if (!origin || new URL(origin).host !== req.get('host')) {
      res.status(403).send('Cross-origin form posts are not allowed.');
      return;
    }
    next();
  });

  r.get('/login', (req, res) => {
    const next = safeNext(str(req.query.next));
    return page(
      res,
      undefined,
      'Sign in',
      html`<div class="card" style="max-width:460px;margin:40px auto">
        <h1>Sign in</h1>
        <p class="muted">
          ${next.startsWith('/oauth/') ? 'Sign in to finish connecting your app. ' : ''}Paste a personal token. Admins get theirs from ADMIN_TOKEN; everyone
          else gets one from an admin.
        </p>
        <form method="post" action="/login">
          <input type="hidden" name="next" value="${next}" />
          <label for="token">Token</label>
          <input id="token" type="password" name="token" autocomplete="current-password" required autofocus />
          <p><button>Sign in</button></p>
        </form>
      </div>`,
    );
  });

  r.post('/login', async (req, res) => {
    const b = req.body as Body;
    const next = safeNext(str(b.next));
    const actor = await actorFromToken(db, str(b.token)?.trim() ?? '');
    if (!actor || actor.tokenKind !== 'human') {
      return back(res, next === '/' ? '/login' : `/login?next=${encodeURIComponent(next)}`, undefined, 'That token is not valid for signing in. Agent tokens only work over MCP.');
    }
    const sid = await createSession(db, actor);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 30 * 86400_000, path: '/' });
    res.redirect(303, next);
  });

  r.post('/logout', async (req, res) => {
    const sid = cookies(req)[COOKIE];
    if (sid) await destroySession(db, sid);
    res.clearCookie(COOKIE, { path: '/' });
    res.redirect(303, '/login');
  });

  r.use((req, res, next) => {
    if (!req.actor) return res.redirect(303, req.method === 'GET' && req.originalUrl !== '/' ? `/login?next=${encodeURIComponent(req.originalUrl)}` : '/login');
    next();
  });

  const wrap = (fn: (req: Request, res: Response) => Promise<void>) => (req: Request, res: Response, next: NextFunction) => fn(req, res).catch(next);

  // ---------- OAuth consent ----------

  r.get(
    '/oauth/consent/:id',
    wrap(async (req, res) => {
      res.set('X-Frame-Options', 'DENY').set('Content-Security-Policy', "frame-ancestors 'none'");
      const pending = await getPending(db, String(req.params.id));
      if (!pending) {
        await page(res, req.actor, 'Connection expired', html`<div class="card" style="max-width:560px;margin:40px auto"><h1>This request expired</h1><p>Start the connection again from your app.</p></div>`, { status: 404 });
        return;
      }
      const app = pending.client.client_name ?? 'An MCP client';
      const target = new URL(pending.redirectUri);
      const destination = target.host ? `${target.protocol}//${target.host}` : target.protocol;
      await page(
        res,
        req.actor,
        `Connect ${app}`,
        html`<div class="card" style="max-width:560px;margin:40px auto">
          <h1>Connect ${app}?</h1>
          <p>${app} wants to use Commonplace as you, ${req.actor!.name}. It can read everything you can and write as your agent.</p>
          <form method="post" action="/oauth/consent/${pending.id}">
            <label for="ceiling_tier">Highest tier it can write directly</label>
            <select id="ceiling_tier" name="ceiling_tier">
              ${([4, 3, 2] as TierRank[]).map((rank) => html`<option value="${rank}" ${rank === 4 ? 'selected' : ''}>${rank} · ${k.tierName(rank)}</option>`)}
            </select>
            <p class="small muted">Above that it files a request for an owner or curator, like any agent token. You can revoke it under Settings.</p>
            <p class="small muted">
              Approving sends you back to <code>${destination}</code>. Commonplace hasn't verified this app, so only approve a connection you started.
            </p>
            <div class="row">
              <button name="decision" value="approve">Approve</button>
              <button name="decision" value="deny" class="secondary">Deny</button>
            </div>
          </form>
        </div>`,
      );
    }),
  );

  r.post(
    '/oauth/consent/:id',
    wrap(async (req, res) => {
      const b = req.body as Body;
      const id = String(req.params.id);
      try {
        const target = b.decision === 'approve' ? await approvePending(db, req.actor!, id, Number(b.ceiling_tier)) : await denyPending(db, id);
        res.redirect(303, target);
      } catch (err) {
        await page(res, req.actor, 'Connection failed', html`<div class="card" style="max-width:560px;margin:40px auto"><h1>Couldn't connect</h1><p>${errorText(err)}</p></div>`, { status: 400 });
      }
    }),
  );

  // ---------- dashboard ----------

  const requestTable = (rows: RequestListRow[], empty: string) =>
    rows.length
      ? html`<table>
          <tr><th>Change</th><th>Entity</th><th>From</th><th>Status</th><th></th></tr>
          ${rows.map(
            (q) => html`<tr>
              <td><a href="/requests/${q.id}">${q.summary}</a><div class="small muted">${q.rationale}</div></td>
              <td>${entityLink(q.entity_id, q.entity_name)} ${tierBadge(q.entity_tier)}</td>
              <td>${q.requested_by_name}${agentBadge(q.token_kind)}</td>
              <td>${statusBadge(q.status)}</td>
              <td class="small muted">${timeAgo(q.created_at)}</td>
            </tr>`,
          )}
        </table>`
      : html`<p class="empty">${empty}</p>`;

  r.get(
    '/',
    wrap(async (req, res) => {
      const actor = req.actor!;
      const [assigned, mine, notes, activity] = await Promise.all([
        k.listRequests(actor, { box: 'assigned', status: 'open', limit: 20 }),
        k.listRequests(actor, { box: 'mine', status: 'open', limit: 10 }),
        listNotifications(db, actor.userId, { unreadOnly: true, limit: 20 }),
        k.recentEvents({ limit: 12 }),
      ]);
      await page(
        res,
        actor,
        'Home',
        html`<div class="row" style="margin-bottom:16px">
            <form method="get" action="/search" class="row" style="flex:3">
              <input type="search" name="q" placeholder="Search people, clients, decisions, facts…" />
              <button class="shrink">Search</button>
            </form>
            <a class="button secondary shrink" href="/new">New entity</a>
          </div>
          <div class="grid">
            <div>
              <div class="card"><h2>Waiting on you</h2>${requestTable(assigned, 'Nothing to review.')}</div>
              <div class="card"><h2>Your open requests</h2>${requestTable(mine, 'You have no open requests.')}</div>
            </div>
            <div>
              <div class="card">
                <h2>Notifications</h2>
                ${notes.length
                  ? html`${notes.map(
                        (n) => html`<div class="fact">
                          <div>${n.link ? html`<a href="${n.link.replace(k.publicUrl, '')}">${n.title}</a>` : n.title}</div>
                          <div class="small muted" style="white-space:pre-line">${n.body}</div>
                          <div class="meta">${timeAgo(n.created_at)}</div>
                        </div>`,
                      )}
                      <form method="post" action="/notifications/read"><button class="secondary">Mark all read</button></form>`
                  : html`<p class="empty">You're all caught up.</p>`}
              </div>
              <div class="card">
                <h2>Recent activity</h2>
                ${activity.map(
                  (e) => html`<div class="small" style="padding:4px 0">
                    <strong>${e.actor_name ?? 'system'}</strong>${agentBadge(e.token_kind)} ${e.action.replace(/[._]/g, ' ')}
                    ${e.entity_id ? entityLink(e.entity_id, e.entity_name ?? '') : ''} <span class="muted">${timeAgo(e.created_at)}</span>
                  </div>`,
                )}
              </div>
            </div>
          </div>`,
      );
    }),
  );

  r.post(
    '/notifications/read',
    wrap(async (req, res) => {
      await markRead(db, req.actor!.userId, 'all');
      back(res, '/');
    }),
  );

  // ---------- search ----------

  r.get(
    '/search',
    wrap(async (req, res) => {
      const q = str(req.query.q)?.trim() ?? '';
      const type = str(req.query.type) || undefined;
      const maxTier = Number(req.query.max_tier) || undefined;
      const ontology = await getOntology(db);
      const results = q ? await k.search(q, { type, maxTier: maxTier as TierRank | undefined, limit: 50 }) : [];
      await page(
        res,
        req.actor,
        q ? `Search: ${q}` : 'Search',
        html`<div class="card">
            <form method="get" class="row">
              <div style="flex:3"><label>Search</label><input type="search" name="q" value="${q}" autofocus /></div>
              <div><label>Type</label><select name="type"><option value="">Any type</option>${ontology.entity_types.map((t) => html`<option value="${t.key}" ${t.key === type ? 'selected' : ''}>${t.name}</option>`)}</select></div>
              <div><label>Trust</label><select name="max_tier"><option value="">Any tier</option>${[1, 2, 3].map((n) => html`<option value="${n}" ${n === maxTier ? 'selected' : ''}>${k.tierName(n as TierRank)} or better</option>`)}</select></div>
              <button class="shrink">Search</button>
            </form>
          </div>
          ${q
            ? html`<div class="card">
                <h2>${results.length} result${results.length === 1 ? '' : 's'}</h2>
                ${results.map(
                  (e) => html`<div class="fact">
                    <div>${entityLink(e.id, e.name)} <span class="badge">${e.type_key}</span> ${tierBadge(e.tier)} ${e.status === 'deprecated' ? html`<span class="badge">deprecated</span>` : ''}</div>
                    ${e.summary ? html`<div class="small">${e.summary}</div>` : ''}
                    ${e.matched_fact ? html`<div class="small muted">Fact: ${e.matched_fact}</div>` : ''}
                    <div class="meta">Owned by ${e.owner_name}</div>
                  </div>`,
                )}
                ${results.length ? '' : html`<p class="empty">No matches. <a href="/new">Create an entity?</a></p>`}
              </div>`
            : ''}`,
      );
    }),
  );

  // ---------- create entity ----------

  const propertyInputs = (type: EntityTypeRow, values: Record<string, unknown> = {}) =>
    type.properties.map((p) => {
      const v = values[p.key];
      const label = html`<label>${p.key}${p.required ? ' *' : ''} <span class="muted small">${p.type}${p.description ? ` · ${p.description}` : ''}</span></label>`;
      if (p.type === 'enum') {
        return html`${label}<select name="prop.${p.key}"><option value=""></option>${(p.options ?? []).map((o) => html`<option ${o === v ? 'selected' : ''}>${o}</option>`)}</select>`;
      }
      if (p.type === 'boolean') {
        return html`${label}<select name="prop.${p.key}"><option value=""></option><option value="true" ${v === true ? 'selected' : ''}>true</option><option value="false" ${v === false ? 'selected' : ''}>false</option></select>`;
      }
      const inputType = p.type === 'url' ? 'url' : p.type === 'date' ? 'date' : 'text';
      return html`${label}<input type="${inputType}" name="prop.${p.key}" value="${v ?? ''}" />`;
    });

  function propsFromForm(type: EntityTypeRow, body: Body, existing?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of type.properties) {
      const v = body[`prop.${p.key}`];
      if (v === undefined) continue;
      if (v === '') {
        if (existing && existing[p.key] !== undefined) out[p.key] = null;
        continue;
      }
      const value = p.type === 'number' ? Number(v) : p.type === 'boolean' ? v === 'true' : v;
      if (!existing || existing[p.key] !== value) out[p.key] = value;
    }
    return out;
  }

  const splitList = (s: string | undefined) => (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

  r.get(
    '/new',
    wrap(async (req, res) => {
      const ontology = await getOntology(db);
      const typeKey = str(req.query.type) ?? ontology.entity_types[0]?.key;
      const type = ontology.entity_types.find((t) => t.key === typeKey);
      await page(
        res,
        req.actor,
        'New entity',
        html`<div class="card" style="max-width:720px">
          <h1>New entity</h1>
          <form method="get" class="row">
            <div><label>Type</label><select name="type" onchange="this.form.submit()">${ontology.entity_types.map((t) => html`<option value="${t.key}" ${t.key === typeKey ? 'selected' : ''}>${t.name}</option>`)}</select></div>
          </form>
          ${type
            ? html`<p class="muted small">${type.description} Default tier: ${k.tierName(type.default_tier)}.</p>
                <form method="post" action="/entities">
                  <input type="hidden" name="type" value="${type.key}" />
                  <label>Name *</label><input type="text" name="name" required />
                  <label>Summary</label><textarea name="summary"></textarea>
                  <label>Aliases <span class="muted small">comma separated</span></label><input type="text" name="aliases" />
                  ${propertyInputs(type)}
                  <div class="row">
                    <div><label>Tier</label><select name="tier">${tierOptions(undefined, 'Default for this type')}</select></div>
                    <div><label>Domain</label><select name="domain"><option value="">Default for this type</option>${ontology.domains.map((d) => html`<option value="${d.key}">${d.name}</option>`)}</select></div>
                  </div>
                  <p><button>Create</button></p>
                </form>`
            : html`<p class="empty">No entity types yet. Define one on the <a href="/ontology">ontology</a> page.</p>`}
        </div>`,
      );
    }),
  );

  r.post(
    '/entities',
    wrap(async (req, res) => {
      const body = req.body as Body;
      try {
        const type = await k.entityType(db, body.type ?? '');
        const e = await k.createEntity(req.actor!, {
          type: type.key,
          name: body.name ?? '',
          summary: body.summary,
          aliases: splitList(body.aliases),
          properties: propsFromForm(type, body),
          tier: body.tier ? (Number(body.tier) as TierRank) : undefined,
          domain: body.domain || undefined,
        });
        back(res, `/e/${e.id}`, `Created ${e.name} as ${k.tierName(e.tier)}.`);
      } catch (err) {
        back(res, `/new?type=${encodeURIComponent(body.type ?? '')}`, undefined, errorText(err));
      }
    }),
  );

  // ---------- entity page ----------

  async function payloadFromForm(entityId: string, action: ActionKey, body: Body): Promise<Record<string, unknown>> {
    if (body.payload_json) return JSON.parse(body.payload_json);
    const tier = body.tier ? Number(body.tier) : undefined;
    switch (action) {
      case 'update_entity': {
        const detail = await k.getEntity(entityId);
        const type = await k.entityType(db, detail.entity.type_key);
        const p: Record<string, unknown> = {};
        if (body.name !== undefined && body.name.trim() !== detail.entity.name) p.name = body.name.trim();
        if (body.summary !== undefined && body.summary !== detail.entity.summary) p.summary = body.summary;
        if (body.aliases !== undefined) {
          const aliases = splitList(body.aliases);
          if (aliases.join('|') !== detail.entity.aliases.join('|')) p.aliases = aliases;
        }
        const props = propsFromForm(type, body, detail.entity.properties);
        if (Object.keys(props).length) p.properties = props;
        return p;
      }
      case 'add_observation':
        return tier ? { content: body.content, tier } : { content: body.content };
      case 'add_relation':
        return tier ? { type: body.type, to: body.to, tier } : { type: body.type, to: body.to };
      case 'set_tier':
        return body.observation_id ? { tier, observation_id: body.observation_id } : { tier };
      case 'retract_observation':
        return { observation_id: body.observation_id };
      case 'remove_relation':
        return { relation_id: body.relation_id };
      case 'transfer_ownership':
        return { new_owner: body.new_owner };
      case 'deprecate_entity':
        return {};
    }
  }

  r.get(
    '/e/:id',
    wrap(async (req, res) => {
      const actor = req.actor!;
      const d = await k.getEntity(req.params.id as string, { includeRetracted: req.query.retracted === '1' });
      const e = d.entity;
      const [type, ontology, requests, history, canEdit, refs] = await Promise.all([
        k.entityType(db, e.type_key),
        getOntology(db),
        k.listRequests(actor, { box: 'all', status: 'any', entityId: e.id, limit: 10 }),
        k.recentEvents({ entityId: e.id, limit: 15 }),
        k.wouldAllow(actor, e.id, 'update_entity', { summary: e.summary }),
        db.query<{ ref: string }>(`select type_key || ':' || name as ref from entities where status = 'active' order by updated_at desc limit 500`),
      ]);
      const isOwner = actor.userId === e.owner_id;
      const relTypes = ontology.relation_types.filter((rt) => !rt.from_types || rt.from_types.includes(e.type_key));
      const byTier = [1, 2, 3, 4].map((t) => ({ tier: t as TierRank, facts: d.observations.filter((o) => o.tier === t) })).filter((g) => g.facts.length);
      const act = (action: ActionKey, fields: Html, button: string, cls = 'link') =>
        html`<form method="post" action="/e/${e.id}/act"><input type="hidden" name="action" value="${action}" />${fields}<button class="${cls}">${button}</button></form>`;

      await page(
        res,
        actor,
        e.name,
        html`<p class="small muted"><a href="/search?type=${e.type_key}">${d.type_name}</a></p>
          <h1>${e.name} ${tierBadge(e.tier)} ${e.status === 'deprecated' ? html`<span class="badge">deprecated</span>` : ''}</h1>
          <p class="muted small">
            Owned by <strong>${d.owner_name}</strong>${isOwner ? ' (you)' : ''} · ${d.domain_name ? html`Domain: ${d.domain_name} · ` : ''}v${e.version} · updated ${timeAgo(e.updated_at)}
            ${e.aliases.length ? html` · also known as ${e.aliases.join(', ')}` : ''}
          </p>
          <div class="grid">
            <div>
              <div class="card">
                ${e.summary ? html`<p style="white-space:pre-line;margin-top:0">${e.summary}</p>` : html`<p class="empty">No summary yet.</p>`}
                ${Object.keys(e.properties).length
                  ? html`<dl class="kv">${Object.entries(e.properties).map(([key, v]) => html`<dt>${key}</dt><dd>${String(v)}</dd>`)}</dl>`
                  : ''}
                <details>
                  <summary>${canEdit ? 'Edit' : 'Suggest an edit'}</summary>
                  ${canEdit ? '' : html`<p class="small muted">${k.tierName(e.tier)} knowledge is curated. Your suggestion goes to ${d.owner_name} for review.</p>`}
                  <form method="post" action="/e/${e.id}/act">
                    <input type="hidden" name="action" value="update_entity" />
                    <input type="hidden" name="mode" value="${canEdit ? 'direct' : 'request'}" />
                    <label>Name</label><input type="text" name="name" value="${e.name}" />
                    <label>Summary</label><textarea name="summary">${e.summary}</textarea>
                    <label>Aliases</label><input type="text" name="aliases" value="${e.aliases.join(', ')}" />
                    ${propertyInputs(type, e.properties)}
                    ${canEdit ? '' : html`<label>Why?</label><textarea name="rationale" required></textarea>`}
                    <p><button>${canEdit ? 'Save' : 'Send for review'}</button></p>
                  </form>
                </details>
              </div>

              <div class="card">
                <h2>Facts</h2>
                ${byTier.length
                  ? byTier.map(
                      (g) => html`<h3>${k.tierName(g.tier)}</h3>
                        ${g.facts.map(
                          (o) => html`<div class="fact" ${o.status === 'retracted' ? raw('style="opacity:.5"') : ''}>
                            <div style="white-space:pre-line">${o.status === 'retracted' ? html`<s>${o.content}</s>` : o.content}</div>
                            <div class="meta">
                              <span>${o.author_name}${agentBadge(o.token_kind)}</span><span>${timeAgo(o.created_at)}</span>
                              ${o.source ? html`<span>from ${o.source.url ? html`<a href="${o.source.url}" rel="noopener" target="_blank">${o.source.kind ?? 'source'}</a>` : o.source.kind ?? 'source'}${o.source.ref ? ` ${o.source.ref}` : ''}${o.source.note ? ` · ${o.source.note}` : ''}</span>` : ''}
                              ${o.status === 'active'
                                ? html`${act('retract_observation', html`<input type="hidden" name="observation_id" value="${o.id}" />`, 'Retract')}
                                    <form method="post" action="/e/${e.id}/act" class="inline-form">
                                      <input type="hidden" name="action" value="set_tier" /><input type="hidden" name="observation_id" value="${o.id}" />
                                      <select name="tier">${tierOptions(o.tier)}</select><button class="link">Move</button>
                                    </form>`
                                : ''}
                            </div>
                          </div>`,
                        )}`,
                    )
                  : html`<p class="empty">No facts yet.</p>`}
                <p class="small"><a href="?retracted=${req.query.retracted === '1' ? '0' : '1'}">${req.query.retracted === '1' ? 'Hide' : 'Show'} retracted</a></p>
                <form method="post" action="/e/${e.id}/act">
                  <input type="hidden" name="action" value="add_observation" />
                  <label>Add a fact</label><textarea name="content" required placeholder="Something true about ${e.name}"></textarea>
                  <div class="row"><div><select name="tier">${tierOptions(undefined, 'Default tier')}</select></div><button class="shrink">Add</button></div>
                </form>
              </div>

              <div class="card">
                <h2>Links</h2>
                ${d.outgoing.length + d.incoming.length
                  ? html`<table>
                      ${[...d.outgoing, ...d.incoming].map(
                        (l) => html`<tr>
                          <td>${e.name} <strong>${l.label}</strong> ${entityLink(l.other_id, l.other_name)} <span class="badge">${l.other_type}</span></td>
                          <td>${tierBadge(l.tier)}</td>
                          <td>${act('remove_relation', html`<input type="hidden" name="relation_id" value="${l.id}" />`, 'Remove')}</td>
                        </tr>`,
                      )}
                    </table>`
                  : html`<p class="empty">Not linked to anything yet.</p>`}
                <form method="post" action="/e/${e.id}/act" class="row" style="margin-top:12px">
                  <input type="hidden" name="action" value="add_relation" />
                  <div><label>Relation</label><select name="type">${relTypes.map((rt) => html`<option value="${rt.key}">${rt.name}</option>`)}</select></div>
                  <div style="flex:2"><label>To</label><input type="text" name="to" list="refs" placeholder="type:name" required /></div>
                  <div><label>Tier</label><select name="tier">${tierOptions(undefined, 'Default')}</select></div>
                  <button class="shrink">Link</button>
                </form>
                <datalist id="refs">${refs.rows.map((x) => html`<option value="${x.ref}"></option>`)}</datalist>
              </div>

              <div class="card"><h2>Neighborhood</h2><div id="graph"></div></div>
            </div>

            <div>
              <div class="card">
                <h2>Trust & ownership</h2>
                <form method="post" action="/e/${e.id}/act" class="row">
                  <input type="hidden" name="action" value="set_tier" />
                  <div><label>Tier</label><select name="tier">${tierOptions(e.tier)}</select></div>
                  <button class="shrink secondary">Set tier</button>
                </form>
                <form method="post" action="/e/${e.id}/act" class="row">
                  <input type="hidden" name="action" value="transfer_ownership" />
                  <div><label>Transfer to</label><input type="email" name="new_owner" placeholder="email" required /></div>
                  <button class="shrink secondary">Transfer</button>
                </form>
                ${e.status === 'active'
                  ? html`<form method="post" action="/e/${e.id}/act" style="margin-top:12px" onsubmit="return confirm('Deprecate this entity?')">
                      <input type="hidden" name="action" value="deprecate_entity" /><button class="danger">Deprecate</button>
                    </form>`
                  : ''}
                <p class="small muted">If you can't make a change directly, you'll be offered a request to the owner instead.</p>
              </div>
              <div class="card">
                <h2>Requests</h2>
                ${requests.length
                  ? requests.map(
                      (q) => html`<div class="fact"><a href="/requests/${q.id}">${q.summary}</a><div class="meta">${statusBadge(q.status)} ${q.requested_by_name}${agentBadge(q.token_kind)} · ${timeAgo(q.created_at)}</div></div>`,
                    )
                  : html`<p class="empty">No requests.</p>`}
              </div>
              <div class="card">
                <h2>History</h2>
                ${history.map(
                  (h) => html`<div class="small" style="padding:3px 0"><strong>${h.actor_name}</strong>${agentBadge(h.token_kind)} ${h.action.replace(/[._]/g, ' ')} <span class="muted">${timeAgo(h.created_at)}</span></div>`,
                )}
              </div>
            </div>
          </div>
          <script src="https://unpkg.com/cytoscape@3.30.2/dist/cytoscape.min.js"></script>
          <script>
            fetch('/e/${raw(e.id)}/graph.json').then(r => r.json()).then(elements => {
              if (typeof cytoscape === 'undefined') return;
              const colors = {1:'#6d28d9',2:'#047857',3:'#1d4ed8',4:'#b45309'};
              const cy = cytoscape({ container: document.getElementById('graph'), elements,
                style: [
                  { selector: 'node', style: { label: 'data(label)', 'font-size': 10, 'background-color': ele => colors[ele.data('tier')], color: '#16181d', 'text-valign': 'bottom', 'text-margin-y': 4, width: 18, height: 18 } },
                  { selector: 'node[?root]', style: { width: 28, height: 28, 'border-width': 3, 'border-color': '#111' } },
                  { selector: 'edge', style: { label: 'data(label)', 'font-size': 8, color: '#5f6672', width: 1.5, 'line-color': '#c5cad3', 'target-arrow-shape': 'triangle', 'target-arrow-color': '#c5cad3', 'curve-style': 'bezier' } }
                ],
                layout: { name: 'cose', animate: false, padding: 20 } });
              cy.on('tap', 'node', evt => { location.href = '/e/' + evt.target.id(); });
            });
          </script>`,
      );
    }),
  );

  r.get(
    '/e/:id/graph.json',
    wrap(async (req, res) => {
      const g = await k.neighbors(req.params.id as string, { depth: 2 });
      res.json([
        ...g.nodes.map((n) => ({ data: { id: n.id, label: n.name, tier: n.tier, root: n.id === g.root } })),
        ...g.edges.map((e) => ({ data: { id: e.id, source: e.from_id, target: e.to_id, label: e.type_key.replace(/_/g, ' ') } })),
      ]);
    }),
  );

  r.post(
    '/e/:id/act',
    wrap(async (req, res) => {
      const actor = req.actor!;
      const id = req.params.id as string;
      const body = req.body as Body;
      const action = body.action as ActionKey;
      if (!ACTIONS.includes(action)) return back(res, `/e/${id}`, undefined, 'Unknown action');
      let payload: Record<string, unknown>;
      try {
        payload = await payloadFromForm(id, action, body);
      } catch (err) {
        return back(res, `/e/${id}`, undefined, errorText(err));
      }

      if (body.mode === 'request') {
        try {
          const request = await k.requestUpdate(actor, { entity: id, action, payload, rationale: body.rationale?.trim() || 'No reason given' });
          return back(res, `/requests/${request.id}`, 'Request sent. The owner has been notified.');
        } catch (err) {
          return back(res, `/e/${id}`, undefined, errorText(err));
        }
      }

      try {
        const result = await k.perform(actor, id, action, payload);
        back(res, `/e/${id}`, `Done: ${result.summary}`);
      } catch (err) {
        if (err instanceof AppError && err.code === 'forbidden') {
          const detail = await k.getEntity(id);
          return page(
            res,
            actor,
            'Request a change',
            html`<div class="card" style="max-width:720px">
              <h1>Ask ${detail.owner_name} to make this change</h1>
              <p>${err.message}</p>
              <p class="muted">Your request goes to the owner, or to whoever can approve it. They'll see what you asked for and why.</p>
              <form method="post" action="/e/${id}/act">
                <input type="hidden" name="action" value="${action}" />
                <input type="hidden" name="mode" value="request" />
                <input type="hidden" name="payload_json" value="${JSON.stringify(payload)}" />
                <label>Change</label><pre>${action} ${JSON.stringify(payload, null, 2)}</pre>
                <label>Why?</label><textarea name="rationale" required autofocus></textarea>
                <p><button>Send request</button> <a class="button secondary" href="/e/${id}">Cancel</a></p>
              </form>
            </div>`,
          );
        }
        back(res, `/e/${id}`, undefined, errorText(err));
      }
    }),
  );

  // ---------- requests ----------

  r.get(
    '/requests',
    wrap(async (req, res) => {
      const box = (['assigned', 'mine', 'all'] as const).find((b) => b === req.query.box) ?? 'assigned';
      const status = (['open', 'approved', 'rejected', 'withdrawn', 'any'] as const).find((s) => s === req.query.status) ?? 'open';
      const rows = await k.listRequests(req.actor!, { box, status, limit: 100 });
      const tab = (b: string, label: string) => html`<a class="button ${b === box ? '' : 'secondary'}" href="?box=${b}&status=${status}">${label}</a>`;
      await page(
        res,
        req.actor,
        'Requests',
        html`<div class="row" style="margin-bottom:16px">
            <div class="shrink">${tab('assigned', 'Waiting on me')} ${tab('mine', 'Mine')} ${tab('all', 'Everyone')}</div>
            <form method="get" class="shrink"><input type="hidden" name="box" value="${box}" />
              <select name="status" onchange="this.form.submit()" style="width:auto">${['open', 'approved', 'rejected', 'withdrawn', 'any'].map((s) => html`<option ${s === status ? 'selected' : ''}>${s}</option>`)}</select>
            </form>
          </div>
          <div class="card">${requestTable(rows, 'No requests here.')}</div>`,
      );
    }),
  );

  function diffView(q: RequestListRow, d: EntityDetail): Html {
    const p = q.payload as Record<string, unknown>;
    if (q.action !== 'update_entity') return html`<pre>${JSON.stringify(p, null, 2)}</pre>`;
    const rows: Html[] = [];
    const cell = (oldV: unknown, newV: unknown) =>
      html`<td>${oldV === undefined || oldV === '' ? html`<span class="muted">empty</span>` : html`<span class="diff-old">${String(oldV)}</span>`}</td><td>${newV === null ? html`<span class="muted">removed</span>` : html`<span class="diff-new">${Array.isArray(newV) ? newV.join(', ') : String(newV)}</span>`}</td>`;
    const e = d.entity;
    if (p.name !== undefined) rows.push(html`<tr><th>name</th>${cell(e.name, p.name)}</tr>`);
    if (p.summary !== undefined) rows.push(html`<tr><th>summary</th>${cell(e.summary, p.summary)}</tr>`);
    if (p.aliases !== undefined) rows.push(html`<tr><th>aliases</th>${cell(e.aliases.join(', '), p.aliases)}</tr>`);
    if (p.domain !== undefined) rows.push(html`<tr><th>domain</th>${cell(d.domain_key, p.domain)}</tr>`);
    for (const [key, v] of Object.entries((p.properties as Record<string, unknown>) ?? {})) rows.push(html`<tr><th>${key}</th>${cell(e.properties[key], v)}</tr>`);
    return html`<table><tr><th>Field</th><th>Now</th><th>Proposed</th></tr>${rows}</table>`;
  }

  r.get(
    '/requests/:id',
    wrap(async (req, res) => {
      const actor = req.actor!;
      const q = await k.getRequest(req.params.id as string);
      const d = await k.getEntity(q.entity_id);
      const open = q.status === 'open';
      const canApprove = open && (await k.wouldAllow(actor, q.entity_id, q.action, q.payload));
      const canReject = open && (canApprove || actor.userId === q.assignee_id || actor.role === 'admin');
      const src = q.source;
      await page(
        res,
        actor,
        'Request',
        html`<p class="small muted"><a href="/requests">Requests</a></p>
          <h1>${q.summary}</h1>
          <p class="muted small">
            ${statusBadge(q.status)} Requested by <strong>${q.requested_by_name}</strong>${agentBadge(q.token_kind)}${q.token_kind === 'agent' ? ` (${q.token_name})` : ''} · ${timeAgo(q.created_at)} ·
            on ${entityLink(q.entity_id, `${q.entity_type}:${q.entity_name}`)} ${tierBadge(d.entity.tier)} · assigned to ${q.assignee_name}
          </p>
          <div class="grid">
            <div>
              <div class="card">
                <h2>Why</h2>
                <p style="white-space:pre-line">${q.rationale}</p>
                ${src ? html`<p class="small muted">Source: ${src.kind ?? ''} ${src.ref ?? ''} ${src.url ? html`<a href="${src.url}" target="_blank" rel="noopener">${src.url}</a>` : ''} ${src.note ?? ''}</p>` : ''}
              </div>
              <div class="card">
                <h2>Proposed change</h2>
                ${open && d.entity.version !== q.base_version ? html`<div class="flash error">The entity has changed since this was requested (v${q.base_version} → v${d.entity.version}). Check the current values.</div>` : ''}
                ${diffView(q, d)}
              </div>
              ${!open
                ? html`<div class="card"><h2>Resolution</h2><p>${statusBadge(q.status)} by ${q.resolved_by_name ?? 'requester'} ${timeAgo(q.resolved_at)}</p>${q.resolution_note ? html`<p style="white-space:pre-line">${q.resolution_note}</p>` : ''}</div>`
                : ''}
            </div>
            <div>
              ${canApprove || canReject
                ? html`<div class="card">
                    <h2>Curate</h2>
                    <form method="post" action="/requests/${q.id}/curate">
                      <label>Note to ${q.requested_by_name}</label><textarea name="note"></textarea>
                      ${canApprove
                        ? html`<details><summary>Edit before approving</summary><textarea name="edits" style="min-height:140px" placeholder="JSON fields to override">${JSON.stringify(q.payload, null, 2)}</textarea></details>`
                        : ''}
                      <p class="row">
                        ${canApprove ? html`<button name="decision" value="approve">Approve</button>` : ''}
                        <button name="decision" value="reject" class="secondary">Reject</button>
                      </p>
                    </form>
                    ${!canApprove ? html`<p class="small muted">You can turn this down, but approving needs someone allowed to make the change.</p>` : ''}
                  </div>`
                : ''}
              ${open && q.requested_by === actor.userId
                ? html`<div class="card"><form method="post" action="/requests/${q.id}/withdraw"><button class="secondary">Withdraw request</button></form></div>`
                : ''}
            </div>
          </div>`,
      );
    }),
  );

  r.post(
    '/requests/:id/curate',
    wrap(async (req, res) => {
      const body = req.body as Body;
      const id = req.params.id as string;
      try {
        let edits: Record<string, unknown> | undefined;
        if (body.decision === 'approve' && body.edits?.trim()) {
          const original = (await k.getRequest(id)).payload;
          const parsed = JSON.parse(body.edits);
          if (JSON.stringify(parsed) !== JSON.stringify(original)) edits = parsed;
        }
        const result = await k.curate(req.actor!, { request_id: id, decision: body.decision === 'approve' ? 'approve' : 'reject', note: body.note?.trim() || undefined, edits });
        back(res, `/requests/${id}`, `Request ${result.request.status}.${result.stale ? ' Heads up: the entity had changed since the request.' : ''}`);
      } catch (err) {
        back(res, `/requests/${id}`, undefined, err instanceof SyntaxError ? 'Edits must be valid JSON.' : errorText(err));
      }
    }),
  );

  r.post(
    '/requests/:id/withdraw',
    wrap(async (req, res) => {
      try {
        await k.withdraw(req.actor!, req.params.id as string);
        back(res, `/requests/${req.params.id}`, 'Request withdrawn.');
      } catch (err) {
        back(res, `/requests/${req.params.id}`, undefined, errorText(err));
      }
    }),
  );

  // ---------- ontology ----------

  r.get(
    '/ontology',
    wrap(async (req, res) => {
      const actor = req.actor!;
      const o = await getOntology(db);
      const policyText = { owner: 'Owner only', curators: 'Owner + domain curators', members: 'Any member' };
      await page(
        res,
        actor,
        'Ontology',
        html`<h1>Ontology</h1>
          <p class="muted">The shape of your knowledge: how much to trust it, who owns what, and which kinds of things and links exist.</p>
          <h3>Trust tiers</h3>
          <div class="tiers">
            ${o.tiers.map(
              (t) => html`<div class="card"><div>${tierBadge(t.rank)} <span class="muted small">tier ${t.rank}</span></div><p class="small">${t.description}</p><p class="small"><strong>Who can change it:</strong> ${policyText[t.write_policy]}</p></div>`,
            )}
          </div>
          <p class="small muted">Owners and admins can always change their knowledge. Promoting into Canon needs the domain owner; into Verified, a curator. Agent tokens never write above their ceiling (Raw by default) and file requests instead.</p>

          <div class="card">
            <h2>Domains</h2>
            <table>
              <tr><th>Domain</th><th>Owner</th><th>Curators</th></tr>
              ${o.domains.map(
                (d) => html`<tr>
                  <td><strong>${d.name}</strong> <code>${d.key}</code><div class="small muted">${d.description}</div></td>
                  <td>${d.owner_name}</td>
                  <td>
                    ${d.curators.map(
                      (c) => html`<div class="small">${c.name} ${actor.role === 'admin' || actor.userId === d.owner_id ? html`<form method="post" action="/ontology/curators" style="display:inline"><input type="hidden" name="domain" value="${d.key}" /><input type="hidden" name="email" value="${c.email}" /><input type="hidden" name="op" value="remove" /><button class="link">remove</button></form>` : ''}</div>`,
                    )}
                    ${actor.role === 'admin' || actor.userId === d.owner_id
                      ? html`<form method="post" action="/ontology/curators" class="row" style="margin-top:6px"><input type="hidden" name="domain" value="${d.key}" /><input type="hidden" name="op" value="add" /><input type="email" name="email" placeholder="curator email" required /><button class="shrink secondary">Add</button></form>`
                      : ''}
                  </td>
                </tr>`,
              )}
            </table>
            ${actor.role === 'admin'
              ? html`<details><summary>New domain</summary>
                  <form method="post" action="/ontology/domains">
                    <div class="row"><div><label>Key</label><input type="text" name="key" placeholder="clients" required /></div><div><label>Name</label><input type="text" name="name" required /></div><div><label>Owner email</label><input type="email" name="owner_email" required /></div></div>
                    <label>Description</label><input type="text" name="description" />
                    <p><button>Create domain</button></p>
                  </form></details>`
              : ''}
          </div>

          <div class="card">
            <h2>Entity types</h2>
            <table>
              <tr><th>Type</th><th>Default tier</th><th>Domain</th><th>Properties</th></tr>
              ${o.entity_types.map(
                (t) => html`<tr>
                  <td><strong>${t.name}</strong> <code>${t.key}</code><div class="small muted">${t.description}</div></td>
                  <td>${tierBadge(t.default_tier)}</td><td>${t.domain_key ?? ''}</td>
                  <td class="small">${t.properties.map((p) => html`<div><code>${p.key}</code> ${p.type}${p.options ? ` (${p.options.join(' | ')})` : ''}${p.required ? ' · required' : ''}</div>`)}</td>
                </tr>`,
              )}
            </table>
            ${actor.role === 'admin' || actor.ownedDomainIds.size
              ? html`<details><summary>Define an entity type</summary>
                  <form method="post" action="/ontology/types">
                    <div class="row"><div><label>Key</label><input type="text" name="key" placeholder="customer_contract" required /></div><div><label>Name</label><input type="text" name="name" required /></div>
                      <div><label>Default tier</label><select name="default_tier">${tierOptions(3)}</select></div>
                      <div><label>Domain</label><select name="domain">${o.domains.map((d) => html`<option value="${d.key}">${d.name}</option>`)}</select></div></div>
                    <label>Description</label><input type="text" name="description" />
                    <label>Properties <span class="muted small">JSON array of { key, type: string|number|boolean|date|url|enum, required?, options? }</span></label>
                    <textarea name="properties">[]</textarea>
                    <p><button>Save type</button></p>
                  </form></details>`
              : ''}
          </div>

          <div class="card">
            <h2>Relation types</h2>
            <table>
              <tr><th>Relation</th><th>From</th><th>To</th></tr>
              ${o.relation_types.map(
                (rt) => html`<tr><td><strong>${rt.name}</strong> <code>${rt.key}</code>${rt.inverse_name ? html`<div class="small muted">inverse: ${rt.inverse_name}</div>` : ''}</td><td class="small">${rt.from_types?.join(', ') ?? 'any'}</td><td class="small">${rt.to_types?.join(', ') ?? 'any'}</td></tr>`,
              )}
            </table>
            ${actor.role === 'admin'
              ? html`<details><summary>Define a relation type</summary>
                  <form method="post" action="/ontology/relations">
                    <div class="row"><div><label>Key</label><input type="text" name="key" placeholder="reports_to" required /></div><div><label>Name</label><input type="text" name="name" placeholder="reports to" required /></div><div><label>Inverse name</label><input type="text" name="inverse_name" placeholder="manages" /></div></div>
                    <div class="row"><div><label>From types <span class="muted small">comma separated, blank = any</span></label><input type="text" name="from_types" /></div><div><label>To types</label><input type="text" name="to_types" /></div></div>
                    <p><button>Save relation</button></p>
                  </form></details>`
              : ''}
          </div>`,
      );
    }),
  );

  const ontologyPost = (fn: (actor: Actor, body: Body) => Promise<unknown>, msg: string) =>
    wrap(async (req, res) => {
      try {
        await fn(req.actor!, req.body as Body);
        back(res, '/ontology', msg);
      } catch (err) {
        back(res, '/ontology', undefined, err instanceof SyntaxError ? 'Properties must be valid JSON.' : errorText(err));
      }
    });

  r.post('/ontology/domains', ontologyPost((a, b) => createDomain(db, a, { key: b.key, name: b.name, description: b.description ?? '', owner_email: b.owner_email }), 'Domain created.'));
  r.post('/ontology/curators', ontologyPost((a, b) => setCurator(db, a, b.domain ?? '', b.email ?? '', b.op === 'add'), 'Curators updated.'));
  r.post(
    '/ontology/types',
    ontologyPost(
      (a, b) =>
        defineEntityType(db, a, {
          key: b.key,
          name: b.name,
          description: b.description ?? '',
          default_tier: Number(b.default_tier),
          domain: b.domain || undefined,
          properties: JSON.parse(b.properties || '[]'),
        }),
      'Entity type saved.',
    ),
  );
  r.post(
    '/ontology/relations',
    ontologyPost(
      (a, b) =>
        defineRelationType(db, a, {
          key: b.key,
          name: b.name,
          inverse_name: b.inverse_name || undefined,
          from_types: splitList(b.from_types).length ? splitList(b.from_types) : undefined,
          to_types: splitList(b.to_types).length ? splitList(b.to_types) : undefined,
        }),
      'Relation type saved.',
    ),
  );

  // ---------- activity ----------

  r.get(
    '/activity',
    wrap(async (req, res) => {
      const events = await k.recentEvents({ limit: 200 });
      await page(
        res,
        req.actor,
        'Activity',
        html`<div class="card"><h2>Activity</h2><table>
          ${events.map(
            (e) => html`<tr><td><strong>${e.actor_name ?? 'system'}</strong>${agentBadge(e.token_kind)}</td><td>${e.action.replace(/[._]/g, ' ')}</td><td>${e.entity_id ? entityLink(e.entity_id, e.entity_name ?? '') : e.target_id ?? ''}</td><td class="small muted">${timeAgo(e.created_at)}</td></tr>`,
          )}
        </table></div>`,
      );
    }),
  );

  // ---------- settings ----------

  async function settingsPage(req: Request, res: Response, reveal?: { label: string; token: string }) {
    const actor = req.actor!;
    const [tokens, users, me] = await Promise.all([
      listTokens(db, actor.userId),
      actor.role === 'admin' ? listUsers(db) : Promise.resolve([]),
      db.query<{ notify_webhook_url: string | null }>('select notify_webhook_url from users where id = $1', [actor.userId]),
    ]);
    const mcpUrl = k.link('/mcp');
    const shown = reveal?.token ?? '<your token>';
    await page(
      res,
      actor,
      'Settings',
      html`<h1>Settings</h1>
        ${reveal
          ? html`<div class="card" style="border-color:#4f46e5">
              <h2>${reveal.label}</h2>
              <p>Copy it now. It won't be shown again.</p>
              <pre>${reveal.token}</pre>
            </div>`
          : ''}
        <div class="card">
          <h2>Connect an agent</h2>
          <p class="small muted">The MCP endpoint is <code>${mcpUrl}</code>. Give each agent its own <strong>agent</strong> token so its writes are labeled and capped at its ceiling.</p>
          <h3>Claude Code</h3>
          <pre>claude mcp add --transport http commonplace ${mcpUrl} --header "Authorization: Bearer ${shown}"</pre>
          <h3>Cursor, VS Code, and other clients</h3>
          <pre>${JSON.stringify({ mcpServers: { commonplace: { url: mcpUrl, headers: { Authorization: `Bearer ${shown}` } } } }, null, 2)}</pre>
        </div>
        <div class="card">
          <h2>Your tokens</h2>
          <table>
            <tr><th>Name</th><th>Kind</th><th>Ceiling</th><th>Last used</th><th></th></tr>
            ${tokens.map(
              (t) => html`<tr ${t.revoked_at ? raw('style="opacity:.5"') : ''}>
                <td>${t.name} <code class="small muted">${t.prefix}…</code></td><td>${t.kind}</td><td>${tierBadge(t.ceiling_tier)}</td>
                <td class="small muted">${t.last_used_at ? timeAgo(t.last_used_at) : 'never'}</td>
                <td>${t.revoked_at ? 'revoked' : html`<form method="post" action="/settings/tokens/${t.id}/revoke"><button class="link">Revoke</button></form>`}</td>
              </tr>`,
            )}
          </table>
          <form method="post" action="/settings/tokens" class="row" style="margin-top:12px">
            <div style="flex:2"><label>Name</label><input type="text" name="name" placeholder="Claude Code on my laptop" required /></div>
            <div><label>Kind</label><select name="kind"><option value="agent">agent</option><option value="human">human</option></select></div>
            <div><label>Ceiling</label><select name="ceiling_tier"><option value="">Default (Raw for agents)</option>${tierOptions()}</select></div>
            <button class="shrink">Create token</button>
          </form>
          <p class="small muted">The ceiling is the most trusted tier the token can write directly, even on knowledge you own. Above it, the token files a request. Agent tokens can't be given a Canon ceiling.</p>
        </div>
        <div class="card">
          <h2>Notifications</h2>
          <p class="small muted">Requests for you always show up here and in the MCP <code>inbox</code> tool. Add a webhook to get pinged too. Slack incoming webhooks work as-is.</p>
          <form method="post" action="/settings/webhook" class="row">
            <div style="flex:3"><input type="url" name="url" value="${me.rows[0]?.notify_webhook_url ?? ''}" placeholder="https://hooks.slack.com/services/…" /></div>
            <button class="shrink secondary">Save</button>
          </form>
        </div>
        ${actor.role === 'admin'
          ? html`<div class="card">
              <h2>People</h2>
              <table>
                <tr><th>Name</th><th>Email</th><th>Role</th></tr>
                ${users.map(
                  (u) => html`<tr><td>${u.name}</td><td>${u.email}</td><td>
                    <form method="post" action="/settings/users/${u.id}/role" class="row" style="gap:6px"><select name="role" style="width:auto">${['member', 'admin'].map((role) => html`<option ${role === u.role ? 'selected' : ''}>${role}</option>`)}</select><button class="link shrink">Save</button></form>
                  </td></tr>`,
                )}
              </table>
              <form method="post" action="/settings/users" class="row" style="margin-top:12px">
                <div><label>Name</label><input type="text" name="name" required /></div>
                <div><label>Email</label><input type="email" name="email" required /></div>
                <div><label>Role</label><select name="role"><option>member</option><option>admin</option></select></div>
                <button class="shrink">Add person</button>
              </form>
              <p class="small muted">You'll get a sign-in token to send them.</p>
            </div>`
          : ''}`,
    );
  }

  r.get('/settings', wrap((req, res) => settingsPage(req, res)));

  r.post(
    '/settings/tokens',
    wrap(async (req, res) => {
      const b = req.body as Body;
      try {
        const token = await createToken(db, req.actor!, { name: b.name, kind: b.kind, ceiling_tier: b.ceiling_tier ? Number(b.ceiling_tier) : undefined });
        await settingsPage(req, res, { label: `New ${b.kind} token: ${b.name}`, token });
      } catch (err) {
        back(res, '/settings', undefined, errorText(err));
      }
    }),
  );

  r.post(
    '/settings/tokens/:id/revoke',
    wrap(async (req, res) => {
      try {
        await revokeToken(db, req.actor!, req.params.id as string);
        back(res, '/settings', 'Token revoked.');
      } catch (err) {
        back(res, '/settings', undefined, errorText(err));
      }
    }),
  );

  r.post(
    '/settings/webhook',
    wrap(async (req, res) => {
      try {
        await setWebhook(db, req.actor!, str((req.body as Body).url)?.trim() || null);
        back(res, '/settings', 'Webhook saved.');
      } catch (err) {
        back(res, '/settings', undefined, errorText(err));
      }
    }),
  );

  r.post(
    '/settings/users',
    wrap(async (req, res) => {
      const b = req.body as Body;
      try {
        const { user, token } = await createUser(db, req.actor!, { name: b.name, email: b.email, role: b.role });
        await settingsPage(req, res, { label: `Sign-in token for ${user.name} (${user.email})`, token });
      } catch (err) {
        back(res, '/settings', undefined, errorText(err));
      }
    }),
  );

  r.post(
    '/settings/users/:id/role',
    wrap(async (req, res) => {
      try {
        await setRole(db, req.actor!, req.params.id as string, (req.body as Body).role === 'admin' ? 'admin' : 'member');
        back(res, '/settings', 'Role updated.');
      } catch (err) {
        back(res, '/settings', undefined, errorText(err));
      }
    }),
  );

  return r;
}
