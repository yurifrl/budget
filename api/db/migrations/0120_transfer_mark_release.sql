-- 0120 · which leg released a bank row (budget-nq2f, transfers T3).
--   When a transfer leg stops being a transfer (its payee edited to an ordinary
--   one, moved to another peer, deleted), the bank row it was linked to is
--   restored and marked 'manual'. `released` remembers WHICH leg released it and
--   what the row looked like then, so that leg alone can re-link exactly that row
--   if its payee is set back to the same transfer. Cleared whenever the mark is
--   written again by anyone else (an unlink, "not a transfer", a link).
--   Additive only: a nullable column on a table the shared database's other app
--   never reads or writes (see 0108); no existing data is changed.
alter table public.transfer_marks add column if not exists released jsonb;
