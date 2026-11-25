-- 0115 · Recorded accepts (budget-edxg). Additive only: one NEW table, which
--   the running syscd-app (sharing this database) never names.
--
--   public.categorize_decisions: what an accept did, so undo can reverse it
--   and nothing else. One row per transaction accept categorized; it records
--   the category accept set (the transaction must have been uncategorized),
--   who accepted it and when. Accept requires that every suggestion of the
--   transaction is pending before it writes, so undo restores that exact
--   state (non-manual suggestions back to pending, the manual row deleted).
--   Undo only reverses a row while the transaction's current category is
--   still this category, and only if the row is not an upcoming occurrence.
--   The row is deleted by undo; the transaction FK cascades on delete.
create table if not exists public.categorize_decisions (
  transaction_id uuid primary key references public.transactions (id) on delete cascade,
  budget_id      uuid not null references public.budgets (id) on delete cascade,
  category_id    uuid not null references public.categories (id) on delete cascade,
  user_id        uuid references public.users (id) on delete set null,
  created_at     timestamptz not null default now()
);

create index if not exists categorize_decisions_budget_idx
  on public.categorize_decisions (budget_id);
