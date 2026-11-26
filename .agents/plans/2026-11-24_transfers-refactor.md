---
title: Transfers refactor: a transfer is a payee that is an account
date: 2026-11-24
description: Replace the several overlapping ways the app marks a transfer with the YNAB model (accounts are payees; a transaction whose payee is an account is a transfer), fix the integrity bugs found on the way, and make Categorize payee-first.
tags: [transfers, payees, categorize, refactor, plan]
---

# Transfers refactor

Maps this plan is built on (read-only research, 2026-11-24):
`scratchpad/transfers-map-api.md` and `scratchpad/transfers-map-client.md`
(session scratchpad; copied as evidence on the epic task).

## Target model (owner's words: "accounts are valid payees, a payee that is an account is a transfer")

1. Every account has exactly one system payee, "Transfer : <account>". The
   system creates it, renames it with the account, and it cannot be edited,
   merged or deleted.
2. A transaction is a transfer if and only if its payee is one of those. One
   definition, in `shared/`, used by the server, the client engine, the
   register and Categorize.
3. A transfer between two on-budget accounts has no category ("Category not
   needed"). A payment to a credit card is a transfer to the card account. A
   transfer to an off-budget account keeps a category, as today.
4. The memory is the payee's Renaming rule: "imported payees that contain X
   are renamed to this payee". A rename rule on a transfer payee makes future
   imports with that text transfers automatically. Manage Payees shows a
   "Transfer Payees" group, one per account, each with Renaming rules.
5. The matcher keeps one job: pair the two sides of a transfer into one linked
   pair. The "Looks like a transfer" popover stays as the place to confirm a
   suspected one.
6. Categorize is payee-first: the AI proposes a payee (a normal payee or an
   account's transfer payee); the category follows from the payee.

## What exists today and what is wrong (from the maps)

- The transfer payee per account already exists, and picking it makes a
  transfer. On top of it: a per-payee "Treat as transfer" rule, a "Transfer
  rules" tab, a "Payment/Transfer" button in the category menu, and the
  matcher's own links. Six client-side definitions of "is a transfer" and
  three of "needs a category" disagree (renamed account, two accounts with
  the same name).
- Integrity bugs: (R1) changing the payee of one side of an auto-linked
  transfer, or deleting it, deletes the other bank-imported row for good and
  later syncs skip it; (R2) a hand-entered transfer plus a later bank import
  of the other side gives two rows; (R3) renaming an account leaves a stale
  "Transfer : old name" payee; (R4/R5) repeating transfers, restored backups
  and copied budgets produce half-linked rows; a transfer row can still carry
  a category the engine ignores.
- Credit-card payment categories are pickable; the phone add sheet cannot
  pick a transfer at all; the matcher is recomputed on every register load.
- Categorize sends suspected transfers to the AI and suggests categories for
  them.

## Constraints

- The database is shared with another running app that reads
  `transactions.transfer_account_id` / `transfer_transaction_id`: schema
  changes are additive only; those columns stay and stay correct.
- Existing data is kept: links (`transfer_links`, the only copy of the
  original payee and category of auto-linked rows), the owner's decisions
  (`transfer_marks`), payee rules.
- No data migration runs on production without the owner's go-ahead.
- Uncommitted transfer UI edits by another session sit in the main checkout
  (register, popover, review list removed). Client tasks start only after
  that work is committed or dropped by its owner.

## Phases and tasks (each task: one tk task, one worktree, an independent review before merge)

### Phase 0: no owner decision needed

- **T0 Land the matcher bank rules** (`budget-zkts`, commit 84aa070, done but
  not on main): bring up to date, review, merge.
  Check: api suite green; the three bank rules have tests.
- **T1 One definition.** `shared/src/domain/transfers.ts` exports the single
  `isTransfer`/`transferOf(row, payees, accounts)` by payee id (never by
  name); `category-needs` uses it; the server and Categorize use it.
  Check: a test with two accounts of the same name and a renamed account
  gives the same answer everywhere; no name-based transfer test left in api.
- **T2 Transfer payee lifecycle (server).** Exactly one per account, created
  with the account, renamed with it, duplicates merged, protected from edit,
  merge and delete; `GET /payees` returns them flagged so pickers and the
  phone sheet can offer them.
  Check: tests for create, rename, duplicate repair, protection; additive
  migration with a pre-check report of duplicates.
- **T3 Integrity (server).** R1: unlinking by editing or deleting one side
  restores the other bank-imported row instead of deleting it. R2: a later
  bank import adopts a hand-made mirror. R4/R5: repeat rules, restore and
  budget copy write complete links. Category is always null on an on-budget
  pair, whatever the entry path.
  Check: the test that pins the deletion is replaced by one that proves the
  row survives and later syncs still see it; a test per path.

### Phase 1: the payee model in the UI (needs the decisions below)

- **T3b Renaming rules assign the payee.** Found while building T2: a
  "contains" renaming rule today rewrites only the matching part of the
  imported text ("PIX SAVINGS 42" becomes "Transfer : X 42", an ordinary
  payee), although the screen says matching payees "will be renamed to" the
  payee. The whole memory mechanism of this plan depends on a matching rule
  assigning the payee itself. Fix on the server: a matching rule sets the
  transaction's payee to the rule's payee (the imported text is kept as the
  import name); a payee can hold several rules (YNAB allows several per
  payee; today it is one, which also makes the duplicate repair drop rules).
  Check: tests for is / contains / starts with / ends with on a normal payee
  and on a transfer payee, the latter producing a linked transfer; existing
  rules keep matching the same rows.

- **T4 Manage Payees.** "Transfer Payees" group with Renaming rules; remove
  the "Treat as transfer" section and the "Transfer rules" tab; migrate
  existing transfer rules to rename rules.
- **T5 Register and pickers.** Remove the "Payment/Transfer" button from the
  category menu; category cell reads "Category not needed" for transfers;
  credit-card payment categories are not pickable; pickers list the same
  accounts everywhere; the phone add sheet can pick a transfer.
- **T6 Popover.** "Always treat X as a transfer" creates a rename rule on the
  chosen account's transfer payee; "Not a transfer" keeps recording the
  decision.
  Check for T4-T6: screenshots at 1400 and 375 of each screen; client suite
  green; a transfer can be made, remembered, and undone on web and phone.

### Phase 2: Categorize payee-first

- **T7 Engine and endpoints.** A suggestion is a payee (normal or transfer)
  plus, for a normal payee, a category. Rows the matcher suspects are not
  sent to the AI; they appear in the queue as "looks like a transfer".
  Accepting a transfer payee makes the transfer and can save the rename rule.
- **T8 Page.** The web page (in progress, `budget-mjug`) and the mobile page
  render the new shape; the popover is reused for suspected transfers.

### Phase 3

- **T9 Cost.** Compute the transfer plan once per budget revision, not on
  every register load.

## Owner decisions (answered 2026-11-24, Inbox thread "Transfers refactor")

1. "Never a transfer" on a payee: KEEP.
2. There is no transfer to an account outside the budget: "that is just a
   transaction". The "outside" state goes away; such a row is a normal
   transaction that needs a category. Existing "outside" marks become normal
   uncategorized rows (shown to the owner, nothing deleted).
3. Existing rules of kind "auto" (account decided by the match): ask the
   owner once per rule which account it is, then turn each into a rename rule
   on that account's transfer payee.
4. The other session's uncommitted transfer UI edits in the main checkout:
   "incorporate them, make them work". Taken as a patch into a task branch
   (T-WIP), finished and reviewed there.
5. Matcher rules (budget-zkts): pairs the rules refuse (card to card,
   checking to a card at another bank) are never auto-linked but still shown
   in "Looks like a transfer" for confirmation.
6. "Same bank": production read on 2026-11-24 shows each live connection
   holds one bank and every linked account carries its bank label (Nubank:
   checking + card; Itaú: checking + card; "Empresa" is hand-entered with no
   bank, so it passes as unknown). The multi-bank-connection case is not
   present in the owner's data; it stays a documented follow-up.

Still open: two accounts with the same name ("Transfer : X (2)" or refuse);
personal and business accounts at the same bank.

## Done means

- Every phase-0 to phase-2 task merged with its checks green and an
  independent review with no open blocker.
- One definition of "is a transfer" in the repo (grep proves the name-based
  checks are gone).
- On a copy of production data: no half-linked rows, one transfer payee per
  account, every former rule represented, balances and Ready to Assign
  unchanged before and after the migration (a script prints the comparison).
- The owner has walked the flow on web and phone: make a transfer by payee,
  see it remembered on the next import, confirm a suspected one, undo.
