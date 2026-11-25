-- 0121 · several renaming rules per payee (budget-mkrt, transfers T3b).
--   A payee used to hold ONE rule on its own row (payees.rename_match_type /
--   rename_condition, 0016). It now holds any number, in a new table, with two
--   more match types ('starts_with', 'ends_with').
--
--   Additive only: a new table, and a copy of the existing rules into it. The
--   columns on payees are NOT dropped or altered: the shared database's other
--   app (syscd-app, same `budget` database, see docs/decisions.md) may still
--   read AND write them, and so may the released client's single-rule endpoint.
--   This app treats them as an input too: a rule found in the columns that the
--   table does not have is adopted (at read time for matching, persisted on the
--   next rule write of that payee), and every rule write here mirrors the
--   payee's first "is"/"contains" rule back into the columns. Nothing erases a
--   column rule it has not first adopted.
--
--   The copy is faithful: each live payee's rule is copied AS IT IS (not
--   trimmed, not case-folded), because matching compares lower-cased text and
--   nothing else. It never drops a rule: the only unique index is on the exact
--   (budget, match type, pattern), which the old unique index on the pattern
--   already guaranteed for live payees. Two patterns that differ only in case
--   stay two rules (the older fires first, as on main); the API refuses to ADD
--   such a duplicate, it does not rewrite the ones that exist.
create table if not exists public.payee_renaming_rules (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets(id) on delete cascade,
  payee_id    uuid not null references public.payees(id) on delete cascade,
  match_type  text not null check (match_type in ('is', 'contains', 'starts_with', 'ends_with')),
  condition   text not null check (condition <> ''),
  created_at  timestamptz not null default now(),
  -- Stable creation order (ties on created_at are common: a fresh start gives every payee one): the last tie-break of the
  -- matching order for NEW rows. The copy numbers the rules by payee age, then physical order (what main read in).
  seq         bigint generated always as identity
);

create unique index if not exists payee_renaming_rules_exact_key
  on public.payee_renaming_rules (budget_id, match_type, condition);
create index if not exists payee_renaming_rules_payee_idx
  on public.payee_renaming_rules (payee_id);

-- Copy: each live payee that has a rule on its row and none in the new table
-- yet (so a re-run changes nothing and never brings back a removed rule).
-- Oldest payee first, so the rules keep main's order (payee creation).
insert into public.payee_renaming_rules (budget_id, payee_id, match_type, condition, created_at)
select p.budget_id, p.id, p.rename_match_type, p.rename_condition, p.created_at
  from public.payees p
 where p.deleted = false
   and p.rename_match_type in ('is', 'contains')
   and p.rename_condition is not null
   and p.rename_condition <> ''
   and not exists (select 1 from public.payee_renaming_rules r where r.payee_id = p.id)
 order by p.created_at, p.ctid
on conflict do nothing;

-- Never silent: should a live payee's rule still not have a row of its own (it
-- cannot with the old unique index in place), say so.
do $$
declare n int;
begin
  select count(*) into n
    from public.payees p
   where p.deleted = false
     and p.rename_match_type in ('is', 'contains')
     and p.rename_condition is not null and p.rename_condition <> ''
     and not exists (select 1 from public.payee_renaming_rules r where r.payee_id = p.id);
  if n > 0 then
    raise warning '0121: % payee rule(s) were not copied (a duplicate pattern)', n;
  end if;
end $$;
