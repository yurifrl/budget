-- =============================================================================
-- 0011 · Recurring transactions — repeat rules + scheduled generation
--   txn_repeat_rules holds the template (payee/account/category/amount/memo)
--   and the schedule (frequency, next_due_date, month_last_day). Generation
--   materializes occurrences as transactions flagged `upcoming`: visible in
--   the register, excluded from budget activity and account balances until
--   the occurrence date passes (YNAB behavior). Idempotency: one live
--   occurrence per (rule, occurrence_date) via a unique partial index.
-- =============================================================================

create table if not exists public.txn_repeat_rules (
  id              uuid primary key default gen_random_uuid(),
  budget_id       uuid not null references public.budgets(id) on delete cascade,
  account_id      uuid not null references public.accounts(id) on delete cascade,
  payee_id        uuid references public.payees(id) on delete set null,
  category_id     uuid references public.categories(id) on delete set null,
  memo            text,
  -- Signed milliunits (outflow negative), mirroring transactions.amount.
  amount          bigint not null,
  frequency       text not null check (frequency in (
    'weekly', 'every-other-week', 'monthly', 'every-other-month',
    'quarterly', 'annually')),
  next_due_date   date not null,
  -- monthly on the last day of each month instead of a fixed day-of-month.
  month_last_day  boolean not null default false,
  deleted         boolean not null default false,
  created_at      timestamptz not null default now()
);
create index if not exists txn_repeat_rules_budget_idx  on public.txn_repeat_rules(budget_id);
create index if not exists txn_repeat_rules_account_idx on public.txn_repeat_rules(account_id);

alter table public.transactions
  add column if not exists repeat_rule_id  uuid references public.txn_repeat_rules(id) on delete set null,
  add column if not exists occurrence_date date,
  add column if not exists upcoming        boolean not null default false;

-- One live occurrence per (rule, occurrence_date) — generation is idempotent.
create unique index if not exists transactions_repeat_occurrence_uq
  on public.transactions(repeat_rule_id, occurrence_date)
  where repeat_rule_id is not null and deleted = false;
create index if not exists transactions_upcoming_flip_idx
  on public.transactions(upcoming) where upcoming and deleted = false;
