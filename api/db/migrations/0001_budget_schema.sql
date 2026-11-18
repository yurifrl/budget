-- =============================================================================
-- 0001 · Budget schema (budget-scoped)
--   Ported from budget-vite/db/migrations/init-99-app.sql and extended for syscd:
--   a "Budget" is the switchable instance (Casa / Trabalho / Viagem) — every
--   row carries budget_id referencing public.budgets.
--   Money is INTEGER CENTS. activity / available / ready-to-assign are DERIVED
--   in the app engine (modules/budget/domain/engine.ts), never stored.
--   Auth is deferred: budgets carries no owner; ownership + membership arrive
--   with 0002_rls.sql (not applied in dev).
-- =============================================================================

create extension if not exists "pgcrypto";

-- ----------------------------------------------------------------------------
-- enums
-- ----------------------------------------------------------------------------
do $$ begin create type account_group as enum ('CASH','CREDIT','CLOSED'); exception when duplicate_object then null; end $$;
do $$ begin create type cleared_status as enum ('cleared','uncleared','reconciled'); exception when duplicate_object then null; end $$;
do $$ begin create type target_cadence as enum ('weekly','monthly','yearly','custom','by-date'); exception when duplicate_object then null; end $$;

-- ----------------------------------------------------------------------------
-- budgets (the switchable instance: Casa / Trabalho / Viagem)
-- ----------------------------------------------------------------------------
create table if not exists public.budgets (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- budget structure (all budget-scoped)
-- ----------------------------------------------------------------------------
create table if not exists public.category_groups (
  id                      uuid primary key default gen_random_uuid(),
  budget_id               uuid not null references public.budgets(id) on delete cascade,
  name                    text not null,
  sort_order              int  not null default 0,
  is_credit_card_payments boolean not null default false,
  created_at              timestamptz not null default now()
);
create index if not exists category_groups_budget_idx on public.category_groups(budget_id);

create table if not exists public.categories (
  id                  uuid primary key default gen_random_uuid(),
  budget_id           uuid not null references public.budgets(id) on delete cascade,
  group_id            uuid not null references public.category_groups(id) on delete cascade,
  name                text not null,
  sort_order          int  not null default 0,
  notes               text not null default '',
  -- embedded target (null cadence => no target)
  target_amount_cents bigint,
  target_cadence      target_cadence,
  target_by_date      date,
  -- behavior for monthly/custom: 'set-aside' | 'refill' | 'have-balance'
  target_behavior     text,
  created_at          timestamptz not null default now()
);
create index if not exists categories_budget_idx on public.categories(budget_id);
create index if not exists categories_group_idx  on public.categories(group_id);

create table if not exists public.accounts (
  id                      uuid primary key default gen_random_uuid(),
  budget_id               uuid not null references public.budgets(id) on delete cascade,
  name                    text not null,
  type                    text not null,                  -- checking|savings|cash|credit|tracking
  account_group           account_group not null,
  on_budget               boolean not null default true,
  cleared_balance_cents   bigint not null default 0,
  uncleared_balance_cents bigint not null default 0,
  last_reconciled_at      timestamptz,
  sort_order              int not null default 0,
  created_at              timestamptz not null default now()
);
create index if not exists accounts_budget_idx on public.accounts(budget_id);

create table if not exists public.transactions (
  id            uuid primary key default gen_random_uuid(),
  budget_id     uuid not null references public.budgets(id) on delete cascade,
  account_id    uuid not null references public.accounts(id) on delete cascade,
  date          date not null,
  payee         text not null default '',
  category_id   uuid references public.categories(id) on delete set null,  -- null => needs a category
  memo          text not null default '',
  outflow_cents bigint not null default 0,
  inflow_cents  bigint not null default 0,
  cleared       cleared_status not null default 'uncleared',
  approved      boolean not null default true,
  flag          text,
  repeat        text not null default 'never',
  created_at    timestamptz not null default now()
);
create index if not exists transactions_budget_idx   on public.transactions(budget_id);
create index if not exists transactions_account_idx  on public.transactions(account_id);
create index if not exists transactions_category_idx on public.transactions(category_id);
create index if not exists transactions_date_idx     on public.transactions(date);

-- monthly assigned amount per category (the ASSIGNED column); month = YYYYMM integer
create table if not exists public.assignments (
  id             uuid primary key default gen_random_uuid(),
  budget_id      uuid not null references public.budgets(id) on delete cascade,
  month          int  not null,
  category_id    uuid not null references public.categories(id) on delete cascade,
  assigned_cents bigint not null default 0,
  unique (budget_id, month, category_id)
);
create index if not exists assignments_budget_month_idx on public.assignments(budget_id, month);

-- per-month note; month = YYYYMM integer
create table if not exists public.month_notes (
  budget_id uuid not null references public.budgets(id) on delete cascade,
  month     int  not null,
  note      text not null default '',
  primary key (budget_id, month)
);
