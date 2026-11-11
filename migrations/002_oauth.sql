-- Optional OAuth 2.1 authorization server for MCP clients (enabled with OAUTH_ENABLED=true).
-- An approved connection is a "grant": an agent row in api_tokens whose own hash is never handed out.
-- Clients hold short-lived access tokens and rotating refresh tokens that resolve to the grant,
-- so revoking the grant under Settings cuts off everything the client holds.

alter table api_tokens add column oauth_client_id text;

create table oauth_clients (
  client_id text primary key,
  client_secret_hash text,
  metadata jsonb not null,
  created_at timestamptz not null default now()
);

create index api_tokens_oauth_grant on api_tokens (user_id, oauth_client_id) where oauth_client_id is not null and revoked_at is null;

-- An authorization request waiting for someone to approve or deny it.
create table oauth_pending (
  id text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  redirect_uri text not null,
  code_challenge text not null,
  state text,
  scopes text[] not null default '{}',
  resource text,
  expires_at timestamptz not null
);

create table oauth_codes (
  code_hash text primary key,
  client_id text not null references oauth_clients(client_id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  ceiling_tier int not null check (ceiling_tier between 2 and 4),
  redirect_uri text not null,
  code_challenge text not null,
  scopes text[] not null default '{}',
  resource text,
  expires_at timestamptz not null,
  used_at timestamptz
);

create table oauth_tokens (
  token_hash text primary key,
  grant_id uuid not null references api_tokens(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  scopes text[] not null default '{}',
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create index oauth_tokens_grant on oauth_tokens (grant_id);
