-- 0119 · transfer hints (budget-nq2f, transfers T3).
--   A bank-sync or statement row whose payee text means "Transfer : <account>"
--   (a renaming rule on a transfer payee, or the text itself) is NOT stored as a
--   payee-only half transfer. It stays an ordinary uncategorized row and this
--   table remembers which account the text pointed at: the matcher treats the
--   row as strong evidence of a transfer with THAT account (one-side suggestion,
--   pairing pinned to the account) until it is linked, categorized or deleted.
--   Additive only: a new table the shared database's other app never reads or
--   writes; no existing data is changed.
create table if not exists public.transfer_hints (
  transaction_id uuid primary key references public.transactions(id) on delete cascade,
  budget_id      uuid not null,
  account_id     uuid not null references public.accounts(id) on delete cascade,
  created_at     timestamptz not null default now()
);
create index if not exists transfer_hints_budget_idx
  on public.transfer_hints (budget_id);
