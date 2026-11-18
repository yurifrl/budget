-- 0023 · Budget members (multi-user sharing, phase 1).
--   A household shares one budget: `budget_members` lists every user who can
--   see and edit a budget's data (no per-member restriction). `owner_user_id`
--   stays the single owner — the only member (besides admins) who may
--   fresh-start, restore, rename, archive, delete or manage the member list.
--   The owner is always also a member row, so "can access" is one lookup;
--   the backfill below seeds that for every existing budget (idempotent).
--   Access SQL lives in server/budget/ownership.ts (budgetAccess → 404).
create table if not exists public.budget_members (
  budget_id uuid not null references public.budgets(id) on delete cascade,
  user_id   uuid not null references public.users(id) on delete cascade,
  added_at  timestamptz not null default now(),
  primary key (budget_id, user_id)
);

create index if not exists budget_members_user_idx on public.budget_members(user_id);

insert into public.budget_members (budget_id, user_id)
select id, owner_user_id from public.budgets where owner_user_id is not null
on conflict do nothing;
