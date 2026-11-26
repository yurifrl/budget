-- 0126 · Suggestion facts fingerprint (categorize run). Additive only: one NEW
--   column on the feature's own suggestions table, which the running syscd-app
--   never names.
--
--   input_fingerprint: the transaction facts a suggestion set was made from
--   (the same expression categorize_attempts stores, see store.ts). A row with
--   pending suggestions is a candidate again exactly when its facts changed
--   since they were written, so a run never replaces an answer that still
--   matches its row.
alter table public.category_suggestions
  add column if not exists input_fingerprint text;
