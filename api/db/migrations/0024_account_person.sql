-- 0024 · Account person (multi-user sharing, phase 2).
--   A household shares one budget, but an account may optionally belong to one
--   person (a budget member). NULL means "Shared" and is the default, so
--   existing data is unchanged. Phase 3 filters the Plan's Activity by this.
--   Membership (owner counts) is validated in the API — see
--   isBudgetMember in server/budget/ownership.ts; removing a member nulls
--   their accounts in that budget (server/budget/routes/members.ts). The FK
--   is `on delete set null` so deleting a user never orphans an account.
alter table public.accounts
  add column if not exists user_id uuid references public.users(id) on delete set null;

create index if not exists accounts_user_idx on public.accounts(user_id);
