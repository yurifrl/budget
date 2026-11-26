-- 0123 · A user's own Jev key (Categorize). Additive only: one NEW table,
--   which the running syscd-app (sharing this database) never names.
--
--   public.jev_keys: one OpenRouter key per user, used for Jev (the category
--   suggestion model). At most one per user, because key resolution is
--   singular: the budget owner's own key wins, else the installation's shared
--   JEV_API_KEY when the `shared-jev-key` feature is on.
--
--   The key never leaves the server in the clear: sealed with
--   core/secret-box (AES-256-GCM), the row's user id bound as additional
--   authenticated data. The last four characters are kept in plain text so the
--   page can show "ends in ••••1234" without decrypting anything.
create table if not exists public.jev_keys (
  user_id           uuid primary key references public.users (id) on delete cascade,
  key_ciphertext    bytea not null,
  key_nonce         bytea not null,
  key_version       integer not null,
  last_four         text not null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
