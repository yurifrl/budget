-- 0129 · A suggestion may name a transfer account instead of a category.
--
--   The Categorize run now also asks about the inflow side of a transfer, and
--   Jev may answer "transfer to/from this account". Such an answer has no
--   category (a transfer between own accounts carries none), so
--   category_suggestions.category_id becomes nullable and a second target column
--   holds the account. A row must name at least one of the two.
--
--   The checks below are the FINAL definitions (0130 states the same ones and
--   explains them): written as 0129 first had them ("exactly one" target, a
--   strict decision check), re-running this file after 0130 would fail on rows
--   only the relaxed checks allow (a released build's leftovers).
--
--   Additive for the other writers of this shared database: they never name the
--   table, and the new column is nullable with no default.
alter table public.category_suggestions
  alter column category_id drop not null;

alter table public.category_suggestions
  add column if not exists transfer_account_id uuid references public.accounts (id) on delete cascade;

alter table public.category_suggestions
  drop constraint if exists category_suggestions_one_target;
alter table public.category_suggestions
  add constraint category_suggestions_one_target
  check (category_id is not null or transfer_account_id is not null);

create index if not exists category_suggestions_transfer_idx
  on public.category_suggestions (budget_id, transfer_account_id)
  where transfer_account_id is not null;

-- Decisions: a third kind. 'transfer' names the account the money moved to or
-- came from and carries no category. Accept links through the register's own
-- transfer path and undo unlinks through it, so the link tables hold what has to
-- be restored; the decision only needs to name the target.
alter table public.categorize_decisions
  add column if not exists transfer_account_id uuid references public.accounts (id) on delete set null;

alter table public.categorize_decisions drop constraint if exists categorize_decisions_kind_check;
alter table public.categorize_decisions add constraint categorize_decisions_kind_check
  check (kind in ('accept', 'skip', 'transfer'));

alter table public.categorize_decisions drop constraint if exists categorize_decisions_category_check;
alter table public.categorize_decisions add constraint categorize_decisions_category_check
  check (
    (kind <> 'accept' or category_id is not null)
    and (kind <> 'transfer' or transfer_account_id is not null)
  );
