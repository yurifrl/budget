-- 0121 · several renaming rules per payee (budget-mkrt, transfers T3b).
--   A payee used to hold ONE rule on its own row (payees.rename_match_type /
--   rename_condition, 0016). It now holds any number, in a new table, with two
--   more match types ('starts_with', 'ends_with').
--
--   Additive only: a new table, and a copy of the existing rules into it. The
--   columns on payees are NOT dropped or altered: the shared database's other
--   app (syscd-app, same `budget` database, see docs/decisions.md) may still
--   read them. This app keeps them as a mirror of each payee's first
--   "is"/"contains" rule (written by the same API calls, never read back by this
--   app), so what that app sees stays what the person set in this one.
--
--   One rule (match type + normalised pattern) belongs to at most one payee per
--   budget, as the old unique index on rename_condition did; the pattern is
--   compared the way matching compares it: trimmed, spaces collapsed, lower case.
create table if not exists public.payee_renaming_rules (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets(id) on delete cascade,
  payee_id    uuid not null references public.payees(id) on delete cascade,
  match_type  text not null check (match_type in ('is', 'contains', 'starts_with', 'ends_with')),
  condition   text not null check (btrim(condition) <> ''),
  created_at  timestamptz not null default now()
);

create unique index if not exists payee_renaming_rules_pattern_key
  on public.payee_renaming_rules (budget_id, match_type, lower(regexp_replace(btrim(condition), '\s+', ' ', 'g')));
create index if not exists payee_renaming_rules_payee_idx
  on public.payee_renaming_rules (payee_id);

-- Copy: each live payee that has a rule on its row and none in the new table
-- yet (so a re-run changes nothing and never brings back a removed rule). Oldest
-- payee first, so when two payees hold the same pattern in different spellings
-- the older keeps it, as matching used to prefer it.
insert into public.payee_renaming_rules (budget_id, payee_id, match_type, condition, created_at)
select p.budget_id, p.id, p.rename_match_type, btrim(p.rename_condition), p.created_at
  from public.payees p
 where p.deleted = false
   and p.rename_match_type in ('is', 'contains')
   and p.rename_condition is not null
   and btrim(p.rename_condition) <> ''
   and not exists (select 1 from public.payee_renaming_rules r where r.payee_id = p.id)
 order by p.created_at, p.id
on conflict do nothing;
