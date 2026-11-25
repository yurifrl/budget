-- 0122 · Applying a renaming rule to past transactions (budget-ou8p). Additive only.
--   connection_transactions.bank_text: the bank's own (trimmed) text of a synced row as the last sync saw it. It is how a later
--     pull knows whether the bank CHANGED the text (then the row takes the current rules) or only sent it again (then it keeps
--     its payee whatever the rules say now). Null on rows stored before this: their text comes from the stored raw object, and
--     when that does not say either, the row counts as unchanged.
--   rename_rule_applies / rename_rule_apply_rows: one record per "apply this rule to past rows" and, per changed row, what it had
--     before and what the apply gave it. Revert takes only the apply id and restores from this record, never from the client.
alter table public.connection_transactions add column if not exists bank_text text;

create table if not exists public.rename_rule_applies (
  id          uuid primary key default gen_random_uuid(),
  budget_id   uuid not null references public.budgets(id) on delete cascade,
  rule_id     uuid not null,
  user_id     uuid,
  created_at  timestamptz not null default now(),
  reverted_at timestamptz
);
create index if not exists rename_rule_applies_budget_idx on public.rename_rule_applies (budget_id, created_at desc);

create table if not exists public.rename_rule_apply_rows (
  apply_id                  uuid not null references public.rename_rule_applies(id) on delete cascade,
  transaction_id            uuid not null references public.transactions(id) on delete cascade,
  budget_id                 uuid not null,
  previous_payee_id         uuid,
  payee_id                  uuid,
  previous_hint_account_id  uuid,
  hint_account_id           uuid,
  primary key (apply_id, transaction_id)
);
create index if not exists rename_rule_apply_rows_transaction_idx on public.rename_rule_apply_rows (transaction_id);
