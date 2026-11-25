-- 0118 · former names of transfer payees (budget-upgg, transfers T2).
--   Renaming an account renames its "Transfer : <account>" payee. The released
--   client keeps sending the payee TEXT it cached on every edit, so a stale
--   "Transfer : <old name>" must still be read as "this row's own payee, unchanged",
--   even when a new account has taken the old name. renameTransferPayee writes
--   one row per name a payee had before a rename, in the same transaction.
--   Additive only: a new table the shared database's other app never reads or
--   writes; no existing data is changed.
create table if not exists public.transfer_payee_former_names (
  payee_id   uuid not null references public.payees(id) on delete cascade,
  budget_id  uuid not null,
  name       text not null,
  created_at timestamptz not null default now(),
  primary key (payee_id, name)
);
create index if not exists transfer_payee_former_names_budget_idx
  on public.transfer_payee_former_names (budget_id);
