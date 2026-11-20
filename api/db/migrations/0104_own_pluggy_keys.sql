-- 0104 · own Pluggy keys (budget-lqi). Additive only: this database is shared
--   with the running syscd-app, which names none of the objects below and
--   keeps inserting connections without `key_source` (the default covers it).
--
--   1. public.connection_credentials: a user's OWN key set for a bank provider
--      (one per user and provider). The client id is plain (it is shown back
--      to the user and sent to the connect widget); the secret is stored only
--      as AES-256-GCM ciphertext + its random nonce, encrypted by the API with
--      the master key from CREDENTIALS_ENCRYPTION_KEY (api/src/core/secret-box.ts).
--      `key_version` names the master key that encrypted the row, so the key
--      can be rotated later. Never a plaintext secret, never pgcrypto.
--
--   2. connections.key_source: which key set created the upstream item,
--      'shared' (the installation's PLUGGY_* keys) or 'own' (the owner's row
--      in connection_credentials). A provider item is reachable only with the
--      credentials that created it. Existing rows are backfilled as 'shared'
--      by the column default. connections.key_client_id: for 'own', the client
--      id the item was created with (NULL for 'shared'); a connection whose
--      owner no longer stores that client id is paused, not synced.
--
--   3. connections.status gains the value 'paused' (the column is free text,
--      no constraint to change): the connection's key set may not be used by
--      its owner right now (shared keys without the 'shared-pluggy-key'
--      feature, or own keys that were removed or replaced). Set and cleared by
--      the API at use time (api/src/connections/keys.ts); syscd-app's sweep
--      only reads status = 'connected' and so leaves paused rows alone.
--
--      connections.paused_from: what a row was when it was paused
--      ({status, status_message, next_poll_at}), restored on resume so an
--      unauthorized or quota-paused bank does not come back looking healthy.
--      NULL whenever the row is not paused.
--
--   4. Feature 'shared-pluggy-key' (default off, public.feature_overrides from
--      0103) is turned ON for every user who already has a connection: those
--      were all created with the shared keys. `on conflict do nothing` keeps a
--      value an admin has already set, so a re-run never turns it back on.
create table if not exists public.connection_credentials (
  user_id uuid not null references public.users (id) on delete cascade,
  provider text not null,
  client_id text not null,
  secret_ciphertext bytea not null,
  secret_nonce bytea not null,
  key_version integer not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider)
);

alter table public.connections add column if not exists key_source text not null default 'shared';
alter table public.connections add column if not exists key_client_id text;
alter table public.connections add column if not exists paused_from jsonb;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'connections_key_source_check') then
    alter table public.connections
      add constraint connections_key_source_check check (key_source in ('shared', 'own'));
  end if;
end $$;

insert into public.feature_overrides (feature_key, user_id, value)
select distinct 'shared-pluggy-key', c.user_id, true
  from public.connections c
 where c.key_source = 'shared'
on conflict (feature_key, user_id) where user_id is not null do nothing;
