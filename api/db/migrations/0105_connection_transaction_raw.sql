-- 0105 · raw provider payload per imported transaction (budget-lkor).
--   Additive only: this database is shared with the running syscd-app, which
--   inserts connection_transactions without these columns (both nullable).
--
--   connection_transactions.raw_payload: the provider's transaction object
--   exactly as last received (every field: raw description, status, type,
--   category, merchant, payment/PIX data, card metadata incl. installments,
--   ...). Metadata only: the sync engine writes it on insert and refreshes it
--   on every pull of an existing row (blocked, user-edited and duplicate rows
--   too) and never derives user-visible fields from it. NULL until the row's
--   next sync for rows imported before this migration.
--
--   connection_transactions.raw_received_at: when raw_payload was last
--   written. Kept apart from updated_at, which tracks engine-owned changes.
alter table public.connection_transactions
  add column if not exists raw_payload jsonb,
  add column if not exists raw_received_at timestamptz;
