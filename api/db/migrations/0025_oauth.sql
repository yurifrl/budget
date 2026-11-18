-- 0025 · OAuth 2.1 authorization server (server/oauth).
--   We are our own authorization server for MCP clients and the CLI; only the
--   human login goes to Google. Secrets (authorization codes, refresh
--   tokens) are stored as SHA-256 hashes only — the raw values exist solely
--   in the response that mints them.

-- Dynamically registered (RFC 7591) public clients. No client secret.
create table if not exists public.oauth_clients (
  client_id     text primary key,
  client_name   text not null,
  redirect_uris text[] not null check (cardinality(redirect_uris) between 1 and 5),
  created_at    timestamptz not null default now()
);
create index if not exists oauth_clients_created_at_idx on public.oauth_clients (created_at);

-- One grant = one user's consent for one client. Refresh tokens and access
-- tokens hang off it; revoking the grant kills both. expires_at is the
-- ABSOLUTE 30-day lifetime (never extended by refreshes).
create table if not exists public.oauth_grants (
  id         uuid primary key,
  user_id    uuid not null references public.users (id) on delete cascade,
  client_id  text not null references public.oauth_clients (client_id) on delete cascade,
  scope      text not null,
  resource   text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz
);
create index if not exists oauth_grants_user_idx on public.oauth_grants (user_id);

-- Single-use authorization codes (10 min). consumed_at is set atomically by
-- the redeeming UPDATE; a second presentation revokes the grant.
create table if not exists public.oauth_codes (
  code_hash      text primary key,
  grant_id       uuid not null references public.oauth_grants (id) on delete cascade,
  redirect_uri   text not null,
  code_challenge text not null,
  expires_at     timestamptz not null,
  consumed_at    timestamptz
);
create index if not exists oauth_codes_expires_idx on public.oauth_codes (expires_at);

-- Rotating refresh tokens. used_at marks a rotated token; presenting one
-- again is a replay and revokes the whole grant.
create table if not exists public.oauth_refresh_tokens (
  token_hash text primary key,
  grant_id   uuid not null references public.oauth_grants (id) on delete cascade,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);
create index if not exists oauth_refresh_tokens_grant_idx on public.oauth_refresh_tokens (grant_id);
