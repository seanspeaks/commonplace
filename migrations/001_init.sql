create extension if not exists pg_trgm;
create extension if not exists citext;

-- array_to_string is only STABLE, which generated columns don't accept.
create function join_words(text[]) returns text language sql immutable parallel safe as $$ select array_to_string($1, ' ') $$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email citext not null unique,
  name text not null,
  role text not null default 'member' check (role in ('admin', 'member')),
  notify_webhook_url text,
  created_at timestamptz not null default now()
);

-- An agent token acts for its user but can never write above its ceiling tier,
-- even on knowledge that user owns. Above the ceiling it files a request instead.
create table api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('human', 'agent')),
  ceiling_tier int not null check (ceiling_tier between 1 and 4),
  token_hash text not null unique,
  prefix text not null,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table sessions (
  id text primary key,
  user_id uuid not null references users(id) on delete cascade,
  token_id uuid not null references api_tokens(id) on delete cascade,
  expires_at timestamptz not null
);

-- Rank 1 is the most trusted. write_policy decides who may change knowledge at this tier
-- besides its owner (owners and admins can always write, subject to token ceilings).
create table tiers (
  rank int primary key check (rank between 1 and 4),
  key text not null unique,
  name text not null,
  description text not null,
  write_policy text not null check (write_policy in ('owner', 'curators', 'members'))
);

insert into tiers (rank, key, name, description, write_policy) values
  (1, 'canon', 'Canon', 'Foundational truth. Policies, commitments, the ontology itself. Only the owner changes it; everyone else requests.', 'owner'),
  (2, 'verified', 'Verified', 'Checked by a person who knows. Owner and domain curators can change it; everyone else requests.', 'curators'),
  (3, 'working', 'Working', 'Team knowledge in active use. Any member can change it.', 'members'),
  (4, 'raw', 'Raw', 'Unreviewed. Where agents and imports land. Anyone can add; curation promotes it.', 'members');

-- Domains are areas of ownership ("clients", "engineering"). Curators of a domain
-- can write Verified knowledge in it.
create table domains (
  id uuid primary key default gen_random_uuid(),
  key text not null unique,
  name text not null,
  description text not null default '',
  owner_id uuid not null references users(id),
  created_at timestamptz not null default now()
);

create table domain_curators (
  domain_id uuid not null references domains(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  primary key (domain_id, user_id)
);

create table entity_types (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  description text not null default '',
  default_tier int not null default 3 references tiers(rank),
  domain_id uuid references domains(id),
  properties jsonb not null default '[]',
  created_at timestamptz not null default now()
);

create table relation_types (
  key text primary key check (key ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  inverse_name text,
  description text not null default '',
  from_types text[],
  to_types text[],
  created_at timestamptz not null default now()
);

create table entities (
  id uuid primary key default gen_random_uuid(),
  type_key text not null references entity_types(key),
  name text not null,
  aliases text[] not null default '{}',
  summary text not null default '',
  properties jsonb not null default '{}',
  tier int not null references tiers(rank),
  owner_id uuid not null references users(id),
  domain_id uuid references domains(id),
  status text not null default 'active' check (status in ('active', 'deprecated')),
  version int not null default 1,
  created_by uuid not null references users(id),
  updated_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  search tsvector generated always as (
    setweight(to_tsvector('english', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('english', join_words(aliases)), 'A') ||
    setweight(to_tsvector('english', coalesce(summary, '')), 'B')
  ) stored
);
create index entities_search_idx on entities using gin (search);
create index entities_name_trgm_idx on entities using gin (name gin_trgm_ops);
create unique index entities_type_name_uniq on entities (type_key, lower(name)) where status = 'active';

-- Facts carry their own tier, so an agent can add a Raw observation to a Canon
-- entity without being able to change the entity itself.
create table observations (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  content text not null,
  tier int not null references tiers(rank),
  source jsonb,
  status text not null default 'active' check (status in ('active', 'retracted')),
  author_id uuid not null references users(id),
  token_id uuid references api_tokens(id) on delete set null,
  created_at timestamptz not null default now(),
  search tsvector generated always as (to_tsvector('english', content)) stored
);
create index observations_entity_idx on observations (entity_id);
create index observations_search_idx on observations using gin (search);

create table relations (
  id uuid primary key default gen_random_uuid(),
  type_key text not null references relation_types(key),
  from_id uuid not null references entities(id) on delete cascade,
  to_id uuid not null references entities(id) on delete cascade,
  tier int not null references tiers(rank),
  source jsonb,
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by uuid not null references users(id),
  token_id uuid references api_tokens(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index relations_uniq on relations (type_key, from_id, to_id) where status = 'active';
create index relations_to_idx on relations (to_id);

create table change_requests (
  id uuid primary key default gen_random_uuid(),
  entity_id uuid not null references entities(id) on delete cascade,
  action text not null check (action in (
    'update_entity', 'add_observation', 'retract_observation', 'add_relation',
    'remove_relation', 'set_tier', 'deprecate_entity', 'transfer_ownership'
  )),
  payload jsonb not null,
  summary text not null,
  rationale text not null,
  source jsonb,
  base_version int not null,
  requested_by uuid not null references users(id),
  token_id uuid references api_tokens(id) on delete set null,
  assignee_id uuid not null references users(id),
  status text not null default 'open' check (status in ('open', 'approved', 'rejected', 'withdrawn')),
  resolution_note text,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  applied jsonb,
  created_at timestamptz not null default now()
);
create index change_requests_assignee_idx on change_requests (assignee_id, status);
create index change_requests_entity_idx on change_requests (entity_id, status);

-- Doubles as an outbox: rows with delivered_at null and a webhook target get pushed by the dispatcher.
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  title text not null,
  body text not null default '',
  link text,
  change_request_id uuid references change_requests(id) on delete cascade,
  read_at timestamptz,
  delivered_at timestamptz,
  delivery_attempts int not null default 0,
  last_error text,
  created_at timestamptz not null default now()
);
create index notifications_user_idx on notifications (user_id, read_at);
create index notifications_outbox_idx on notifications (created_at) where delivered_at is null;

create table events (
  id bigserial primary key,
  actor_id uuid references users(id),
  token_id uuid references api_tokens(id) on delete set null,
  action text not null,
  target_kind text not null,
  target_id text,
  entity_id uuid,
  before jsonb,
  after jsonb,
  created_at timestamptz not null default now()
);
create index events_entity_idx on events (entity_id, created_at desc);
create index events_created_idx on events (created_at desc);
