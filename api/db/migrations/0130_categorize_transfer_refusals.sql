-- 0130 · Transfer answers: refusals per account pair, the mark a transfer
--   accept replaced, and constraints that nothing legitimate can violate.
--
--   A "not a transfer" answer names one PAIR (row, other account): the same row
--   may still be a transfer to a different account, so the refusal is its own
--   row and not the matcher's whole-row mark (`transfer_marks`). Every read and
--   every run filters on it.
--
--   Additive for the other writers of this shared database: they never name
--   these tables, and the new column is nullable with no default.
create table if not exists public.categorize_transfer_refusals (
  transaction_id      uuid not null references public.transactions (id) on delete cascade,
  budget_id           uuid not null references public.budgets (id) on delete cascade,
  transfer_account_id uuid not null references public.accounts (id) on delete cascade,
  user_id             uuid references public.users (id) on delete set null,
  created_at          timestamptz not null default now(),
  primary key (transaction_id, transfer_account_id)
);
alter table public.categorize_transfer_refusals
  add column if not exists user_id uuid references public.users (id) on delete set null;
create index if not exists categorize_transfer_refusals_budget_idx
  on public.categorize_transfer_refusals (budget_id);

-- A transfer accept links both legs and the register's unlink then marks both
-- 'manual'. Undo puts each leg back exactly as it was, so the marks the accept
-- replaced are remembered per transaction id (JSON null = the row had no mark;
-- a leg the link created is absent and undo deletes it outright).
alter table public.categorize_decisions
  add column if not exists prev_marks jsonb;
alter table public.categorize_decisions drop constraint if exists categorize_decisions_prev_marks_check;
alter table public.categorize_decisions add constraint categorize_decisions_prev_marks_check
  check (prev_marks is null or jsonb_typeof(prev_marks) = 'object');

-- The account an accepted transfer named: when the account goes, so does the
-- decision. `on delete set null` contradicted the kind check below (a
-- 'transfer' with no account), which would have made deleting an account fail.
alter table public.categorize_decisions
  drop constraint if exists categorize_decisions_transfer_account_id_fkey;
alter table public.categorize_decisions
  add constraint categorize_decisions_transfer_account_id_fkey
  foreign key (transfer_account_id) references public.accounts (id) on delete cascade;

-- The three kinds, stated as what each one REQUIRES and nothing more. A
-- column left over from another kind's row is not a reason to refuse a write,
-- which is what keeps a RELEASED build honest during a rollout: its skip says
-- `set kind='skip', category_id=null` and leaves `transfer_account_id` behind on
-- a row it is un-transferring. Every reader states its own meaning (a skip is a
-- skip whatever target column survives), so the leftovers are inert.
alter table public.categorize_decisions drop constraint if exists categorize_decisions_category_check;
alter table public.categorize_decisions add constraint categorize_decisions_category_check
  check (
    (kind <> 'accept' or category_id is not null)
    and (kind <> 'transfer' or transfer_account_id is not null)
  );

-- A suggestion must name a target; both is tolerated for the same rollout reason
-- (a released upsert sets `category_id` and leaves `transfer_account_id` on the
-- rank that held a transfer). Readers decide by the same rule everywhere: the
-- category is the target whenever it is set, so a legacy row reads as exactly
-- one category suggestion and is never a transfer answer.
alter table public.category_suggestions drop constraint if exists category_suggestions_one_target;
alter table public.category_suggestions add constraint category_suggestions_one_target
  check (category_id is not null or transfer_account_id is not null);
