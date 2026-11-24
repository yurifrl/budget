-- 0108 · transfers between own accounts: suggestions, decisions, payee rules (budget-mit6).
--   Additive only (new columns with defaults/nullable, two new tables). The
--   shared database's other writers never read or write these.
--
--   payees.transfer_rule: what the transfer matcher does with rows of this payee.
--     null / 'off'  no rule (the matcher decides from amounts, dates and bank hints);
--     'auto'        always a transfer: linked to the matching row in any other
--                   on-budget account of the budget;
--     'account'     always a transfer to transfer_rule_account_id;
--     'never'       never a transfer: no suggestion, never auto-linked.
--   payees.transfer_rule_account_id: the fixed other account ('account' only).
--   payees.transfer_rule_no_match: when no matching row shows up within
--     transfer_rule_wait_days of the row's date: 'outside' = keep it as a
--     transfer to an account outside the budget (no category asked), 'review' =
--     leave it for review (a one-side suggestion).
--   payees.transfer_rule_since: the rule covers rows created at or after this
--     instant (null = every row, set by "Apply to past rows").
alter table public.payees
  add column if not exists transfer_rule text,
  add column if not exists transfer_rule_account_id uuid references public.accounts(id) on delete set null,
  add column if not exists transfer_rule_no_match text not null default 'outside',
  add column if not exists transfer_rule_wait_days smallint not null default 5,
  add column if not exists transfer_rule_since timestamptz;

--   transfer_marks: a person's decision about one row the matcher looked at.
--     'dismissed' "Not a transfer": never suggested or linked again;
--     'outside'   a transfer to an account outside the budget (no category);
--     'manual'    a link the person undid: still suggested, never auto-linked.
create table if not exists public.transfer_marks (
  transaction_id uuid primary key references public.transactions(id) on delete cascade,
  budget_id      uuid not null,
  state          text not null check (state in ('dismissed', 'outside', 'manual')),
  created_at     timestamptz not null default now()
);
create index if not exists transfer_marks_budget_idx on public.transfer_marks (budget_id);

--   transfer_links: one row per leg the matcher or a person linked as a
--   transfer, holding what unlinking (Undo) restores: the leg's payee,
--   category and sync-shadow `blocked` flag before the link. `method` says who
--   linked it ('auto' matcher, 'rule' payee rule, 'user'); `created_mirror` is
--   true on a leg the link inserted (no bank row existed), which unlinking
--   deletes instead of restoring.
create table if not exists public.transfer_links (
  transaction_id      uuid primary key references public.transactions(id) on delete cascade,
  budget_id           uuid not null,
  peer_transaction_id uuid not null,
  method              text not null check (method in ('auto', 'rule', 'user')),
  prev_payee_id       uuid,
  prev_category_id    uuid,
  prev_blocked        boolean,
  created_mirror      boolean not null default false,
  created_at          timestamptz not null default now()
);
create index if not exists transfer_links_budget_idx on public.transfer_links (budget_id);
