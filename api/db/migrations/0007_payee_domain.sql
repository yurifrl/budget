-- =============================================================================
-- 0007 · Payee domain: hidden flag, categorization mode, rename rules
--   payees gain hidden (picker filter), categorization_mode
--   (auto | fixed | never) and default_category_id (used by the fixed mode).
--   payee_rename_rules rewrite raw import/entry payee names before payee
--   resolution (e.g. "SQ *BLUE BOTTLE" -> "Blue Bottle Coffee").
-- =============================================================================

alter table public.payees
  add column if not exists hidden               boolean not null default false,
  add column if not exists categorization_mode  text not null default 'auto'
    check (categorization_mode in ('auto', 'fixed', 'never')),
  add column if not exists default_category_id  uuid references public.categories(id) on delete set null;

create table if not exists public.payee_rename_rules (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets(id) on delete cascade,
  pattern     text not null,
  match_type  text not null default 'contains' check (match_type in ('contains')),
  replacement text not null,
  created_at  timestamptz not null default now(),
  unique (budget_id, pattern)
);
create index if not exists payee_rename_rules_budget_idx on public.payee_rename_rules(budget_id);

do $$
declare t text;
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_budget_member') then
    foreach t in array array['payee_rename_rules']
    loop
      execute format('alter table public.%1$s enable row level security;', t);
      execute format('drop policy if exists %1$s_member_all on public.%1$s;', t);
      execute format(
        'create policy %1$s_member_all on public.%1$s
           for all using (public.is_budget_member(budget_id))
           with check (public.is_budget_member(budget_id));', t);
    end loop;
  end if;
end $$;
