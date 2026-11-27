---
title: Implementer brief: Categorize runs of any size, and transfers
date: 2026-11-27
description: Two changes to the Categorize feature. The person chooses how many transactions a run sends (no fixed cap, a safety rate limit only), and Jev can say a transaction is a transfer to one of the budget's accounts; transfers are shown in their own section at the top of the page.
tags: [categorize, jev, transfers, brief]
---

# Categorize: run size and transfers

Owner's words: "no cap user chooses how many he is going to run, this is a
batch in temporal and jev is cheap have a limit but put it over 3000 per
hour" and "you must classify things as transfers, try to match payee,
transfers have no categories, transfer should be a special category, should
show matches in a special place at top of the others with a divider".

## How to work

- Read `AGENTS.md` and follow it. Read the current code of
  `api/src/categorize/`, `api/src/jev/`, `shared/src/contracts/categorize/`,
  `client/src/features/categorize/`, and how transfers work today:
  `shared/src/domain/transfers.ts`, `shared/src/domain/category-needs.ts`,
  `api/src/budget/domain/transfer-payees.ts`, `transfer-links.ts`, the
  transfer suggestion endpoints (`budget_transfer_suggestions_list`,
  `budget_transfers_link`, `budget_transfers_mark`) and the client feature
  `client/src/features/transfers/`.
- Do not commit, push or change git state. Do not run `tk`. Do not start
  servers or the app. Tests only. Never print a key.
- The working tree has uncommitted partial edits from an interrupted attempt
  to raise the run limit to 5000 (`CATEGORIZE_RUN_LIMIT`, `run-store.ts`,
  `run.ts`, `workflows.ts`, `run.logic.ts`, i18n, tests). They are not
  finished and may not compile. Part A replaces that idea: keep what is
  useful, remove the rest.
- Reuse what exists. No second definition of "is a transfer", no second way
  to make a transfer. Least code that meets the checks.
- api tests: `BUDGET_REQUIRE_TEST_DB=1 BUDGET_TEST_PG_BASE=postgres://postgres:postgres@192.168.64.3:5432`
  (never `127.0.0.1:55432`).

## Part A: the person chooses how many

- The start endpoint takes how many transactions to send: a number, or "all
  waiting". No fixed per-run cap of 100.
- The confirmation on the page lets the person pick: all waiting (the
  default, with the real count), or a number they type. It shows the count
  that will really be sent.
- Safety only: a rate limit per budget of 5000 transactions per rolling hour
  across runs (one shared constant; it must stay above 3000). A start that
  would pass it sends what is left in the hour and the page says so; with
  nothing left it is refused with its own code and sentence (en + pt-BR)
  saying when it frees up.
- One run still means one Temporal job with a total fixed at its first
  delivery, 4 calls in flight, resumable progress. Check the activity
  timeouts in `workflows.ts` against a 5000-row run (about 0.4 s per call;
  15 s worst case each) and set them so a long run is not cut off, with a
  heartbeat at least every few rows. A run cut off anyway must resume within
  its total (it does today; keep the tests that prove it).
- The candidate list for a large run must not be loaded or held in a way that
  breaks at 5000 rows.

## Part B: transfers

Model (already in the app): every account has one system payee
"Transfer : <account>". A transaction whose payee is one of those is a
transfer. A transfer between two on-budget accounts has no category.

1. **Jev may answer "transfer".** The choice question gets, besides the
   categories, one option per account the money could have gone to or come
   from (every open account of the budget except the transaction's own),
   keyed so it cannot collide with a category id (for example
   `transfer:<account id>`), labelled "Transfer / <account name>". The state
   gains what helps Jev tell: the transaction's own account name and type,
   and whether another account has an opposite-signed transaction of the same
   amount within a few days (a yes/no plus that account's name; one SQL
   query). The 255-option limit counts categories plus accounts.
2. **Inflows too.** Today a run only sends rows that need a category, which
   excludes inflows. The incoming side of a transfer is an inflow. A row is
   also a candidate when it is an inflow that is not already a transfer and
   has an opposite-signed same-amount row in another account of the budget
   within a few days; for those rows only transfer options are offered (no
   categories), plus one option "Not a transfer".
3. **Storing it.** A suggestion is either a category or a transfer to an
   account: additive migration (0129 or higher, with its
   `MIGRATION_SIGNATURES` entry) that lets `category_suggestions` carry
   `transfer_account_id` instead of `category_id` (exactly one of the two
   set). The contract's suggestion gains the transfer account (id and name).
4. **Accepting it.** Accepting a transfer suggestion sets the transaction's
   payee to that account's transfer payee through the existing transaction
   update path, so the existing rules make it a transfer, clear the category
   and pair it with the other side when there is one. Undo restores the
   previous payee and category. Bundle accept works for transfer suggestions
   the same way as for categories. Nothing is applied automatically.
5. **The matcher's own pairs.** Rows the transfer matcher already suspects
   (today excluded from the run and invisible on this page) are listed in the
   same Transfers section as "looks like a transfer", with both sides shown,
   and confirmed or refused there with the existing link / mark operations.
   They are still not sent to Jev.
6. **The page.** A "Transfers" section at the top of the Categorize page,
   above the category bundles, separated from them by a divider with its own
   heading. It holds the matcher's pairs first, then Jev's transfer
   suggestions (grouped by account pair). Each row shows amount, date, both
   accounts and the certainty; actions: accept, not a transfer, skip. In One
   by one, a transfer suggestion shows as "Transfer to <account>" /
   "Transfer from <account>" with the same keys as a category suggestion.
   A transfer row never shows a category picker. All strings through `t()`
   in en + pt-BR. Works at desktop and phone width.

## Checks (paste real output)

- `shared/`, `api/`, `client/`: `bunx tsc --noEmit`, `bunx eslint .`,
  `bun test`, all green.
- Part A tests: a run of 130 waiting rows asks about all 130; a chosen number
  is respected; the hourly limit trims a start and refuses one with nothing
  left; the count in the status equals what a run sends.
- Part B tests: transfer options are offered and never collide with category
  ids; an inflow with a counterpart is a candidate with transfer options
  only; an inflow without one is not a candidate; a transfer answer is stored
  with the account and no category; accepting it makes the transaction a
  transfer with no category and pairs the other side; undo restores it; a
  refused matcher pair is not offered again; the candidate-rule test still
  agrees with the shared rule for outflows.
- One live smoke test (skipped without `JEV_API_KEY`): a made-up "PIX
  TRANSFERENCIA ENTRE CONTAS" row with a counterpart gets a transfer answer.

## Order

Part A first, stop and report with check output. Then Part B server, stop and
report. Then Part B page, stop and report.
