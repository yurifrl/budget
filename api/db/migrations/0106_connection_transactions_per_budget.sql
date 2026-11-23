-- 0106 · bank-id identity is per budget (budget-mwp0).
--   One bank connection belongs to a user and can feed accounts in several of
--   their budgets. Budgets are isolated, so the same bank transaction imports
--   into every budget whose account links that upstream account. The import
--   ledger's key was global, unique (provider, external_transaction_id), which
--   made the second budget skip every row as "already imported elsewhere".
--
--   connection_transactions.budget_id: the budget of the shadowed transaction
--   (always transactions.budget_id). Backfilled here, then NOT NULL. A
--   BEFORE INSERT trigger fills it from the transaction when an insert leaves
--   it out, so a writer that predates this column still works.
--
--   The one non-additive statement: dropping the global unique constraint
--   (0014's connection_transactions_provider_external_transaction_id_key). It
--   is what forbids a second budget's copy, so it cannot stay alongside the
--   per-budget key. Checked before writing this: syscd-app (which shares the
--   database) no longer has any code reading or writing connection_transactions
--   (its connections feature was removed), so nothing relies on that
--   constraint or upserts with ON CONFLICT (provider, external_transaction_id).
alter table public.connection_transactions
  add column if not exists budget_id uuid references public.budgets(id) on delete cascade;

update public.connection_transactions s
   set budget_id = t.budget_id
  from public.transactions t
 where t.id = s.transaction_id
   and s.budget_id is null;

alter table public.connection_transactions
  alter column budget_id set not null;

create or replace function public.connection_transactions_fill_budget() returns trigger
language plpgsql as $$
begin
  if new.budget_id is null then
    select t.budget_id into new.budget_id from public.transactions t where t.id = new.transaction_id;
  end if;
  return new;
end;
$$;

drop trigger if exists connection_transactions_fill_budget on public.connection_transactions;
create trigger connection_transactions_fill_budget
  before insert on public.connection_transactions
  for each row execute function public.connection_transactions_fill_budget();

alter table public.connection_transactions
  drop constraint if exists connection_transactions_provider_external_transaction_id_key;

create unique index if not exists connection_transactions_budget_key
  on public.connection_transactions (budget_id, provider, external_transaction_id);
