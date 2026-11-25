-- 0116 · Decision kind and queue changes bump the budget revision. Additive
--   only (the branch's 0115 is unreleased; this keeps that file immutable).
--
--   kind          'accept' (category set, category_id required) or 'skip'
--                 (the person chose to leave it uncategorized, category_id
--                 null). One decision per transaction; undo only reverses
--                 kind='accept' and never touches a skip.
--   category_id   now nullable so a skip has no category.
--
--   Revision: categorize_decisions was not in the 0033 trigger list, so a
--   skip did not bump budgets.revision. It gets the same deferred trigger as
--   every other budget-scoped table; the trigger function dedupes per
--   transaction. Deliberately NOT category_suggestions: the classifier writes
--   it up to 100 times per run, and every write would make open clients refetch
--   the whole budget for the duration of the run.
alter table public.categorize_decisions add column if not exists kind text;
update public.categorize_decisions set kind = 'accept' where kind is null;
alter table public.categorize_decisions alter column kind set default 'accept';
alter table public.categorize_decisions alter column kind set not null;
alter table public.categorize_decisions alter column category_id drop not null;

alter table public.categorize_decisions drop constraint if exists categorize_decisions_kind_check;
alter table public.categorize_decisions add constraint categorize_decisions_kind_check
  check (kind in ('accept', 'skip'));

alter table public.categorize_decisions drop constraint if exists categorize_decisions_category_check;
alter table public.categorize_decisions add constraint categorize_decisions_category_check
  check ((kind = 'accept' and category_id is not null) or (kind = 'skip' and category_id is null));

drop trigger if exists budget_revision_bump on public.categorize_decisions;
create constraint trigger budget_revision_bump
  after insert or update or delete on public.categorize_decisions
  deferrable initially deferred for each row
  execute function public.budget_revision_bump();
