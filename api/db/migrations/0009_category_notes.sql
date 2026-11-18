-- =============================================================================
-- 0009 · Category notes (per category + month)
--   The plan-screen category inspector keeps a freeform note per category per
--   month (bead syscd-app-nrg). Distinct from the budget-wide category note
--   (categories.note) and the month-level note (month_notes).
-- =============================================================================

create table if not exists public.category_notes (
  budget_id   uuid not null references public.budgets (id) on delete cascade,
  category_id uuid not null references public.categories (id) on delete cascade,
  month       date not null,
  note        text not null default '',
  primary key (budget_id, category_id, month)
);

create index if not exists category_notes_budget_month_idx
  on public.category_notes (budget_id, month);

-- RLS for the new table — only when 0002 (auth-era) has been applied;
-- the dev stack mounts 0001/0003/0004 without 0002, so this must be a no-op
-- until is_budget_member exists.
do $$
declare t text;
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_budget_member') then
    foreach t in array array['category_notes']
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
