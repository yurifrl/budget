-- =============================================================================
-- 0003 · Payees (budget-scoped)
--   Saved payees backing the add-transaction payee picker. Transactions keep
--   their free-text `payee` column; this table is the dedupe/autocomplete
--   list, upserted on save and managed by name.
-- =============================================================================

create table if not exists public.payees (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references public.budgets(id) on delete cascade,
  name       text not null,
  created_at timestamptz not null default now(),
  unique (budget_id, name)
);
create index if not exists payees_budget_idx on public.payees(budget_id);

-- backfill from transactions recorded before this table existed
insert into public.payees (budget_id, name)
select distinct budget_id, payee from public.transactions where payee <> ''
on conflict (budget_id, name) do nothing;
