-- Recall (context pushed to agents by hooks and the recall tool) and Dream (the optional nightly pass).

create table app_settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

-- Which entities were handed to whom. No prompt text is kept.
create table recall_log (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_id uuid references api_tokens(id) on delete set null,
  via text not null check (via in ('tool', 'hook')),
  entity_ids uuid[] not null,
  created_at timestamptz not null default now()
);
create index recall_log_created_idx on recall_log (created_at);

-- Learned nightly from recall_log and events: how often an entity is recalled and then acted on.
create table entity_signals (
  entity_id uuid primary key references entities(id) on delete cascade,
  recalled int not null default 0,
  used int not null default 0,
  boost real not null default 0,
  updated_at timestamptz not null default now()
);

create table dream_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null check (status in ('running', 'done', 'failed')),
  inference text not null check (inference in ('off', 'on')),
  model text,
  stats jsonb not null default '{}',
  note text
);

-- Machine-written digests of an entity's facts. A cache, never knowledge: they carry the tier of the
-- least trusted fact they cite and are shown as unreviewed.
create table entity_briefs (
  entity_id uuid primary key references entities(id) on delete cascade,
  brief text not null,
  cited uuid[] not null,
  authority_tier int not null check (authority_tier between 1 and 4),
  model text not null,
  run_id uuid references dream_runs(id) on delete set null,
  created_at timestamptz not null default now()
);

create table dream_findings (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references dream_runs(id) on delete cascade,
  kind text not null check (kind in ('duplicate', 'orphan', 'aging_raw', 'stale_request', 'contradiction')),
  entity_ids uuid[] not null,
  detail text not null,
  created_at timestamptz not null default now()
);
create index dream_findings_run_idx on dream_findings (run_id);
