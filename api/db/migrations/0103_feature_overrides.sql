-- 0103 · features: stored values of the features listed in code
--   (shared/src/features.ts). One NEW table for every feature: this database
--   is shared with the running syscd-app, which never names it.
--
--   A row is one stored on/off value of one feature:
--     user_id NULL  = the value for everyone (at most one row per feature);
--     user_id set   = that user's override (at most one row per feature and user).
--   Resolution: the user's override, else the everyone value, else the default
--   in code. No row = nothing stored. feature_key has no foreign key: the list
--   lives in code, and a key that is no longer listed is ignored.
--
--   changed_by / changed_at: who last set the value and when (no history
--   table). Deleting the user an override belongs to deletes the override;
--   deleting the admin who set a value keeps the value and clears changed_by.
create table if not exists public.feature_overrides (
  id uuid primary key default gen_random_uuid(),
  feature_key text not null,
  user_id uuid references public.users (id) on delete cascade,
  value boolean not null,
  changed_by uuid references public.users (id) on delete set null,
  changed_at timestamptz not null default now()
);

create unique index if not exists feature_overrides_everyone_key on public.feature_overrides (feature_key) where user_id is null;
create unique index if not exists feature_overrides_user_key on public.feature_overrides (feature_key, user_id) where user_id is not null;
create index if not exists feature_overrides_user_idx on public.feature_overrides (user_id) where user_id is not null;
create index if not exists feature_overrides_changed_by_idx on public.feature_overrides (changed_by) where changed_by is not null;
