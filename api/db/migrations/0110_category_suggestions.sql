-- 0110 · Category suggestions (the "Categorize" page). Additive only: one NEW
--   table, which the running syscd-app (sharing this database) never names.
--
--   public.category_suggestions: read-only model suggestions for an
--   UNCATEGORIZED transaction, at most three per transaction (rank 1 = best).
--   The categorize_run job writes this table and NEVER writes
--   transactions.category_id: accepting a suggestion goes through the normal
--   transaction update path.
--
--     source      'payee_rule' (the existing payee categorization rule answered
--                 first; provider/model NULL, confidence 1) or 'ai' (the model).
--                 No check constraint: the list is code, and adding a source is
--                 a deploy, not a migration.
--     status      'pending' when written. The queue/accept task moves a row to
--                 accepted/dismissed; this task never writes another value.
--                 No check constraint, for the same reason as `source`.
--     provider    the AI provider id that produced an 'ai' suggestion.
--     model       the model the provider reported for that answer.
--     rank 1..3   stable per transaction; a re-run upserts in place, so the
--                 same transaction never has duplicate ranks.
--
--   Confidence is the model's 0..1 self-report (the payee rule records 1).
--   The API filters by the budget's threshold at read time, so changing the
--   threshold never needs a re-run.
create table if not exists public.category_suggestions (
  transaction_id uuid not null references public.transactions (id) on delete cascade,
  budget_id      uuid not null references public.budgets (id) on delete cascade,
  rank           smallint not null check (rank between 1 and 3),
  category_id    uuid not null references public.categories (id) on delete cascade,
  confidence     real not null check (confidence >= 0 and confidence <= 1),
  reason         text,
  source         text not null,
  provider       text,
  model          text,
  status         text not null default 'pending',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (transaction_id, rank)
);
create index if not exists category_suggestions_budget_status_idx
  on public.category_suggestions (budget_id, status);
