-- 0112 · categorize_attempts (budget-fvtx MF1). Additive only: one NEW table.
--
--   Why a table and not a marker in category_suggestions: an attempt that
--   produced no suggestion has no category, and category_suggestions is keyed
--   (transaction_id, rank 1..3) with a NOT NULL category_id. A marker row would
--   force nullable category/rank columns and make every existing query
--   (threshold, pending, rank upsert) exclude it. The attempts table keeps one
--   row per transaction, written by every attempt whatever its outcome, and
--   leaves the suggestion set untouched.
--
--   outcome        'suggested' (rows written, model or payee rule),
--                  'no_suggestion' (a valid empty answer) or 'failed' (the
--                  transaction could not be classified; error_kind says why).
--                  No check constraint: the list is code, like `source`.
--   error_kind     the CategorizeFailureKind of a failed attempt (never
--                  provider text), NULL otherwise.
--   attempts       consecutive attempts by the same rule; an explicit
--                  re-classify (force) resets it to 1. A failed transaction is
--                  retried after an exponential backoff until
--                  CATEGORIZE_MAX_ATTEMPTS, then only by force.
--   input_fingerprint  md5 of the effective payee and memo at attempt time
--                  (SQL expression in api/src/categorize/store.ts). A
--                  no_suggestion transaction is skipped until its payee/memo
--                  changes; this is what makes it a fingerprint, not a lock.
--   model          the model reported for the answer, NULL for the payee rule.
--
--   The queue/accept task reads this table to tell "not classified yet" (no
--   row) from "classified, no suggestion" (outcome = 'no_suggestion').
create table if not exists public.categorize_attempts (
  transaction_id    uuid primary key references public.transactions (id) on delete cascade,
  budget_id         uuid not null references public.budgets (id) on delete cascade,
  outcome           text not null,
  error_kind        text,
  attempts          integer not null default 1,
  model             text,
  input_fingerprint text not null,
  last_attempt_at   timestamptz not null default now()
);
create index if not exists categorize_attempts_budget_outcome_idx
  on public.categorize_attempts (budget_id, outcome, last_attempt_at);
