-- =============================================================================
-- 0008 · Category targets (one per category)
--   Funding targets for the plan screen: weekly / monthly / yearly / custom
--   (by date + repeat). `config` holds kind-specific knobs as a JSONB map so
--   each target kind keeps its own shape without extra columns.
-- =============================================================================

create table if not exists public.category_targets (
  id            uuid primary key default gen_random_uuid(),
  budget_id     uuid not null references public.budgets (id) on delete cascade,
  category_id   uuid not null references public.categories (id) on delete cascade,
  kind          text not null check (kind in ('weekly', 'monthly', 'yearly', 'custom')),
  amount_cents  bigint not null check (amount_cents >= 0),
  config        jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (category_id)
);

create index if not exists category_targets_budget_id_idx
  on public.category_targets (budget_id);
