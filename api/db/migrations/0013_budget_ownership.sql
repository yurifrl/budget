-- 0013 · Budget ownership (v1.1 Phase 2 — USER-03/04/05)
--   A budget belongs to someone. `owner_user_id` ships NULL so pre-v1.1
--   rows exist unowned; the first real sign-in claims them transactionally
--   and idempotently via server/ownership.ts (claimUnownedBudgets), which
--   also finalizes the column to NOT NULL once zero unowned rows remain.
--   Accounts/transactions/payees/… stay budget-scoped: they resolve
--   ownership transitively through their budget_id, so no per-table churn.
--   Enforcement is app-layer (budgetAccess owner-or-admin → 404);
--   the dead is_budget_member RLS blocks in 0004/0011 are deleted in this
--   wave and RLS remains a documented future hardening step.

alter table public.budgets
  add column if not exists owner_user_id uuid references public.users(id) on delete restrict,
  add column if not exists claimed_at timestamptz;

create index if not exists budgets_owner_user_idx on public.budgets(owner_user_id);
