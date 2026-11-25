-- 0109 · AI keys (category suggestions). Additive only: one NEW table, which
--   the running syscd-app (sharing this database) never names.
--
--   public.ai_credentials: one AI provider key per user, for the "Categorize"
--   feature. A user has at most one AI key at a time (saving replaces the row),
--   because key resolution is singular: own key wins, else the installation's
--   shared key when feature 'shared-ai-key' is on.
--
--     provider           adapter id, one of the five listed in
--                        shared/src/contracts/ai/outputs.ts. No check
--                        constraint: the list is code, and adding a provider is
--                        a deploy, not a migration.
--     secret_ciphertext  the API key, AES-256-GCM ciphertext
--     secret_nonce       its random 96-bit nonce
--     key_version        master key version that sealed it (CREDENTIALS_ENCRYPTION_KEY)
--     model              the model id the user picked, NULL until they pick one
--
--   Sealed with core/secret-box.ts, context ['ai_credentials', user_id], so a
--   ciphertext copied onto another user does not open. Never plaintext, never
--   pgcrypto.
create table if not exists public.ai_credentials (
  user_id uuid primary key references public.users (id) on delete cascade,
  provider text not null,
  secret_ciphertext bytea not null,
  secret_nonce bytea not null,
  key_version integer not null,
  model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
