-- 0120 · what an adoption replaced (budget-nq2f, transfers T3).
--   When a bank row replaces a hand-made mirror of a transfer, the link record
--   of the bank row remembers the replaced row and the fields it took over, so
--   POST /transfers/unlink restores the state from before the adoption.
--   Additive only: a nullable column on a table the shared database's other app
--   never reads or writes (see 0108); no existing data is changed.
alter table public.transfer_links add column if not exists adopted jsonb;
