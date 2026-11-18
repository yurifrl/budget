-- 0014 · Connections (v1.1 Phase 4 — provider-neutral bank sync substrate).
--   One `connections` row per bank link: a user connects a provider item, the
--   adapter stores its upstream id in `external_id` and its connect-flow
--   identity in `client_user_id`. The bank link itself is a property of the
--   budget `accounts` row (`connection_id` + `external_account_id`), not a
--   mirror entity — a budget account links to at most one upstream account.
--   Field names/values mirror server/connections/types.ts rather than
--   inventing a parallel vocabulary.
--
--   Scoping mirrors the server convention: user_id is a real FK (cascade on
--   identity delete); enforcement is app-layer (requireUser + owner-or-404).

create table public.connections (
  id              uuid primary key,
  user_id         uuid not null references public.users(id) on delete cascade,
  provider        text not null,
  external_id     text not null,
  client_user_id  text,
  status          text not null,
  environment     text,
  institution     text,
  last_synced_at  timestamptz,
  next_poll_at    timestamptz,
  poll_failures   int not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (provider, external_id)
);

create index connections_user_idx on public.connections(user_id);

-- The link is a property of the account: unlink (connection deleted) keeps
-- the account, it just loses its bank link.
alter table public.accounts
  add column connection_id       uuid references public.connections(id) on delete set null,
  add column external_account_id text,
  add column institution         text;

-- connection_events · dedupe ledger for inbound webhook deliveries.
-- One row per processed (provider, eventId); the handler answers a replayed
-- eventId with a 200 no-op instead of re-applying its effects. Pruned by the
-- poller tick (30-day retention).
create table public.connection_events (
  event_id         text primary key,
  provider         text not null,
  external_item_id text,
  payload          jsonb not null default '{}'::jsonb,
  received_at      timestamptz not null default now()
);

create index connection_events_item_idx
  on public.connection_events(external_item_id);

create index connection_events_received_idx
  on public.connection_events(received_at);

-- connection_transactions · import ledger for the sync engine. One row per
-- provider-origin transaction row:
--   * external_transaction_id  — upstream id (import_id is '<provider>:' + this).
--   * last_synced_payload      — the fields the engine owns (date, amount,
--     memo, payee name) as last written, for user-modification detection.
--   * blocked                  — user modified the row; the engine stops
--     updating and deleting it (user edits are authoritative, never re-pushed).
-- Rows are cleaned up with their transaction via ON DELETE CASCADE.
create table public.connection_transactions (
  transaction_id        uuid primary key references public.transactions(id) on delete cascade,
  provider              text not null,
  external_transaction_id text not null,
  last_synced_payload   jsonb not null default '{}'::jsonb,
  blocked               boolean not null default false,
  updated_at            timestamptz not null default now(),
  unique (provider, external_transaction_id)
);

-- The poller scans connected items by due time.
create index connections_poll_due_idx
  on public.connections (next_poll_at)
  where status = 'connected';
