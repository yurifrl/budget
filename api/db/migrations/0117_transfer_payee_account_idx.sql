-- 0117 · index payees(transfer_account_id) (budget-upgg, transfers T2).
--   Every account has one system payee "Transfer : <account>", found by
--   `payees.transfer_account_id` (renames, the repair, the payee list). The
--   column had no index. Additive and NOT unique on purpose: "one per account"
--   is kept by the application (domain/transfer-payees.ts) and healed by the
--   repair (domain/transfer-payee-repair.ts, scripts/repair-transfer-payees.ts),
--   because the shared database's other app also writes this table and a
--   unique index would turn its writes into errors on data that has duplicates
--   today. No data is changed by this migration.
create index if not exists payees_transfer_account_idx
  on public.payees (transfer_account_id)
  where transfer_account_id is not null;
