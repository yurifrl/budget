-- =============================================================================
-- 0004 · YNAB v1 API compatibility (openspec/changes/ynab-compat-schema)
--   Reshapes storage into a lossless superset of the YNAB v1 data model
--   (OpenAPI spec 1.85.0): milliunits, signed transaction amounts, payee_id
--   references, the goal model, first-of-month date months, tombstone
--   `deleted` flags, and the split/scheduled/payee-location tables.
--   Derived values (activity, available, RTA, goal progress, *_formatted)
--   stay derived in the engine — never stored.
--   App-side extras (sort_order, account_group, repeat, is_credit_card_payments)
--   are kept: a superset may carry more than YNAB, never less.
--   Conversions run in-place; on a fresh initdb the tables are empty and the
--   updates are no-ops.
-- =============================================================================

-- ----------------------------------------------------------------------------
-- budgets · YNAB BudgetSummary metadata
-- ----------------------------------------------------------------------------
alter table public.budgets
  add column if not exists date_format      jsonb,
  add column if not exists currency_format  jsonb,
  add column if not exists last_modified_on timestamptz not null default now();

-- ----------------------------------------------------------------------------
-- payees · transfer linkage + tombstone (table from 0003)
-- ----------------------------------------------------------------------------
alter table public.payees
  add column if not exists transfer_account_id uuid references public.accounts(id) on delete set null,
  add column if not exists deleted             boolean not null default false;

-- ----------------------------------------------------------------------------
-- accounts · full YNAB Account shape, milliunits
-- ----------------------------------------------------------------------------
alter table public.accounts
  add column if not exists closed                  boolean not null default false,
  add column if not exists note                    text,
  add column if not exists transfer_payee_id       uuid references public.payees(id) on delete set null,
  add column if not exists direct_import_linked    boolean not null default false,
  add column if not exists direct_import_in_error  boolean not null default false,
  add column if not exists debt_interest_rates     jsonb,
  add column if not exists debt_minimum_payments   jsonb,
  add column if not exists debt_escrow_amounts     jsonb,
  add column if not exists deleted                 boolean not null default false;

update public.accounts set closed = true where account_group = 'CLOSED' and not closed;

-- legacy app types -> YNAB AccountType values
update public.accounts set type = 'creditCard' where type = 'credit';
update public.accounts set type = 'otherAsset' where type = 'tracking';
alter table public.accounts drop constraint if exists accounts_type_check;
alter table public.accounts add constraint accounts_type_check check (type in (
  'checking','savings','cash','creditCard','lineOfCredit','otherAsset','otherLiability',
  'mortgage','autoLoan','studentLoan','personalLoan','medicalDebt','otherDebt'
));

-- cents -> milliunits (column names match YNAB fields)
alter table public.accounts rename column cleared_balance_cents   to cleared_balance;
alter table public.accounts rename column uncleared_balance_cents to uncleared_balance;
update public.accounts set cleared_balance = cleared_balance * 10, uncleared_balance = uncleared_balance * 10;

-- one transfer payee per account ("Transfer : <name>"), as YNAB maintains
insert into public.payees (budget_id, name, transfer_account_id)
select a.budget_id, 'Transfer : ' || a.name, a.id
from public.accounts a
on conflict (budget_id, name) do update set transfer_account_id = excluded.transfer_account_id;
update public.accounts a
set transfer_payee_id = p.id
from public.payees p
where p.budget_id = a.budget_id and p.transfer_account_id = a.id and a.transfer_payee_id is null;

-- ----------------------------------------------------------------------------
-- category_groups / categories · hidden/internal + YNAB goal model
-- ----------------------------------------------------------------------------
alter table public.category_groups
  add column if not exists hidden   boolean not null default false,
  add column if not exists internal boolean not null default false,
  add column if not exists deleted  boolean not null default false;
update public.category_groups set internal = true where is_credit_card_payments and not internal;

alter table public.categories
  add column if not exists hidden                  boolean not null default false,
  add column if not exists internal                boolean not null default false,
  add column if not exists deleted                 boolean not null default false,
  add column if not exists goal_type               text check (goal_type in ('TB','TBD','MF','NEED','DEBT')),
  add column if not exists goal_needs_whole_amount boolean,
  add column if not exists goal_day                int,
  add column if not exists goal_cadence            int check (goal_cadence between 0 and 14),
  add column if not exists goal_cadence_frequency  int,
  add column if not exists goal_creation_month     date,
  add column if not exists goal_target             bigint,
  add column if not exists goal_target_date        date,
  add column if not exists goal_snoozed_at         timestamptz;

-- YNAB `note` is nullable free text
alter table public.categories rename column notes to note;
alter table public.categories alter column note drop not null;
alter table public.categories alter column note drop default;

-- embedded target -> goal model (design: monthly->NEED c1, weekly->NEED c2,
-- yearly->NEED c13, custom->NEED c1, by-date->TBD, have-balance->TB,
-- set-aside->needs_whole_amount)
update public.categories set
  goal_type = case
    when target_behavior = 'have-balance' then 'TB'
    when target_cadence  = 'by-date'      then 'TBD'
    else 'NEED'
  end,
  goal_target = target_amount_cents * 10,
  goal_target_date = case when target_cadence = 'by-date' then target_by_date end,
  goal_cadence = case
    when target_behavior = 'have-balance' then null
    when target_cadence = 'monthly' then 1
    when target_cadence = 'weekly'  then 2
    when target_cadence = 'yearly'  then 13
    when target_cadence = 'custom'  then 1
    else null
  end,
  goal_cadence_frequency = case
    when target_behavior <> 'have-balance' and target_cadence in ('monthly','weekly','yearly','custom') then 1
  end,
  goal_needs_whole_amount = case target_behavior
    when 'set-aside' then true
    when 'refill'    then false
  end
where target_amount_cents is not null and target_cadence is not null;

alter table public.categories
  drop column if exists target_amount_cents,
  drop column if exists target_cadence,
  drop column if exists target_by_date,
  drop column if exists target_behavior;
drop type if exists target_cadence;

-- ----------------------------------------------------------------------------
-- transactions · signed milliunit amount, payee_id, flags, linkage, import
-- ----------------------------------------------------------------------------
alter table public.transactions
  add column if not exists amount                     bigint,
  add column if not exists payee_id                   uuid references public.payees(id) on delete set null,
  add column if not exists flag_name                  text,
  add column if not exists transfer_account_id        uuid,
  add column if not exists transfer_transaction_id    uuid,
  add column if not exists matched_transaction_id     uuid,
  add column if not exists import_id                  text,
  add column if not exists import_payee_name          text,
  add column if not exists import_payee_name_original text,
  add column if not exists debt_transaction_type      text check (debt_transaction_type in (
    'payment','refund','fee','interest','escrow','balanceAdjustment','credit','charge')),
  add column if not exists deleted                    boolean not null default false;

update public.transactions set amount = (inflow_cents - outflow_cents) * 10 where amount is null;
alter table public.transactions alter column amount set not null;
alter table public.transactions drop column outflow_cents, drop column inflow_cents;

-- free-text payee -> payee_id (payees backfilled from transactions in 0003;
-- re-run for rows created since, then resolve ids and drop the text column)
insert into public.payees (budget_id, name)
select distinct budget_id, payee from public.transactions where payee <> ''
on conflict (budget_id, name) do nothing;
update public.transactions t
set payee_id = p.id
from public.payees p
where t.payee_id is null and t.payee <> '' and p.budget_id = t.budget_id and p.name = t.payee;
alter table public.transactions drop column payee;

alter table public.transactions rename column flag to flag_color;
alter table public.transactions add constraint transactions_flag_color_check
  check (flag_color in ('red','orange','yellow','green','blue','purple',''));

alter table public.transactions alter column memo drop not null;
alter table public.transactions alter column memo drop default;

-- YNAB: import_id is unique per account (among live rows)
create unique index if not exists transactions_account_import_id_uq
  on public.transactions(account_id, import_id) where import_id is not null and not deleted;
create index if not exists transactions_payee_idx on public.transactions(payee_id);

-- ----------------------------------------------------------------------------
-- subtransactions (splits) · new
-- ----------------------------------------------------------------------------
create table if not exists public.subtransactions (
  id                      uuid primary key default gen_random_uuid(),
  budget_id               uuid not null references public.budgets(id) on delete cascade,
  transaction_id          uuid not null references public.transactions(id) on delete cascade,
  amount                  bigint not null,
  memo                    text,
  payee_id                uuid references public.payees(id) on delete set null,
  category_id             uuid references public.categories(id) on delete set null,
  transfer_account_id     uuid,
  transfer_transaction_id uuid,
  deleted                 boolean not null default false,
  created_at              timestamptz not null default now()
);
create index if not exists subtransactions_budget_idx on public.subtransactions(budget_id);
create index if not exists subtransactions_txn_idx    on public.subtransactions(transaction_id);

-- ----------------------------------------------------------------------------
-- scheduled transactions · new (YNAB model; the app's lightweight
-- transactions.repeat column remains as an app-side extra)
-- ----------------------------------------------------------------------------
create table if not exists public.scheduled_transactions (
  id                  uuid primary key default gen_random_uuid(),
  budget_id           uuid not null references public.budgets(id) on delete cascade,
  account_id          uuid not null references public.accounts(id) on delete cascade,
  date_first          date not null,
  date_next           date not null,
  frequency           text not null check (frequency in (
    'never','daily','weekly','everyOtherWeek','twiceAMonth','every4Weeks','monthly',
    'everyOtherMonth','every3Months','every4Months','twiceAYear','yearly','everyOtherYear')),
  amount              bigint not null default 0,
  memo                text,
  flag_color          text check (flag_color in ('red','orange','yellow','green','blue','purple','')),
  flag_name           text,
  payee_id            uuid references public.payees(id) on delete set null,
  category_id         uuid references public.categories(id) on delete set null,
  transfer_account_id uuid,
  deleted             boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists scheduled_transactions_budget_idx  on public.scheduled_transactions(budget_id);
create index if not exists scheduled_transactions_account_idx on public.scheduled_transactions(account_id);

create table if not exists public.scheduled_subtransactions (
  id                       uuid primary key default gen_random_uuid(),
  budget_id                uuid not null references public.budgets(id) on delete cascade,
  scheduled_transaction_id uuid not null references public.scheduled_transactions(id) on delete cascade,
  amount                   bigint not null,
  memo                     text,
  payee_id                 uuid references public.payees(id) on delete set null,
  category_id              uuid references public.categories(id) on delete set null,
  transfer_account_id      uuid,
  deleted                  boolean not null default false,
  created_at               timestamptz not null default now()
);
create index if not exists scheduled_subtransactions_budget_idx on public.scheduled_subtransactions(budget_id);
create index if not exists scheduled_subtransactions_parent_idx on public.scheduled_subtransactions(scheduled_transaction_id);

-- ----------------------------------------------------------------------------
-- payee_locations · new (YNAB stores lat/long as strings)
-- ----------------------------------------------------------------------------
create table if not exists public.payee_locations (
  id         uuid primary key default gen_random_uuid(),
  budget_id  uuid not null references public.budgets(id) on delete cascade,
  payee_id   uuid not null references public.payees(id) on delete cascade,
  latitude   text not null,
  longitude  text not null,
  deleted    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists payee_locations_budget_idx on public.payee_locations(budget_id);
create index if not exists payee_locations_payee_idx  on public.payee_locations(payee_id);

-- ----------------------------------------------------------------------------
-- months · first-of-month dates, YNAB column names, tombstones
-- ----------------------------------------------------------------------------
alter table public.assignments alter column month type date using to_date(month::text, 'YYYYMM');
alter table public.assignments rename column assigned_cents to budgeted;
update public.assignments set budgeted = budgeted * 10;

alter table public.month_notes alter column month type date using to_date(month::text, 'YYYYMM');
alter table public.month_notes add column if not exists deleted boolean not null default false;
