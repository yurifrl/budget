---
title: Implementer brief: category suggestions with Jev
date: 2026-11-26
description: What is broken in the Categorize feature today and what to build so that Jev produces the category suggestions. Self-contained; the implementer works from this file and the code only.
tags: [categorize, jev, brief]
---

# Category suggestions with Jev: implementer brief

## How to work

- This brief and the code in the working tree are your only sources. Do not
  read git history, `CHANGELOG.md`, `handoff.md`, `.tasks/`, or any other file
  in `.agents/plans/`. Do not try to recover, restore or imitate any earlier
  code. If something looks like a leftover of an older design, do not build on
  it or reason from it: design from this brief, as if it were a new feature.
- Do NOT run git, in any form (no status, diff, log, stash, checkout, add,
  commit). Do NOT run `tk` (it calls git). Work directly in this checkout.
- Read `AGENTS.md` first and follow it (contracts, handler layout, migrations,
  strings through `t()` in English and pt-BR, ports, databases).
- Write the least code that meets the checks. No provider abstraction, no
  adapter interface, no model picker, no options nobody asked for. One
  provider exists: Jev.
- Never print, log or write the key anywhere.
- Report honestly: paste real command output; say what you did not run.

## The goal

On the Categorize page the owner presses Run. For each transaction that still
needs a category, the server asks Jev which of the budget's categories fits,
and stores the three most probable categories with their probabilities. The
page then shows those suggestions; the owner accepts them in bundles above a
certainty threshold or one by one. Nothing is applied automatically.

## What Jev is

Jev (`typesafe/jev-1.13`) is a decision model, not a chat model: no messages,
no tool calls, no text. You send a `state` and typed `questions`; a `choice`
question returns a probability for every option. It is reached through
OpenRouter with an OpenRouter key.

```
POST https://openrouter.ai/api/alpha/decisions
Authorization: Bearer <key>          Content-Type: application/json

{ "model": "typesafe/jev-1.13",
  "state": { "payee": "...", "bank_text": "...", "amount": -58.9, "date": "2026-11-20",
             "account": "...", "same_payee_categorized_before_as": ["Food / Groceries", "..."] },
  "questions": { "category": {
      "type": "choice",
      "instructions": "Which budget category does this bank transaction belong to?",
      "criteria": { "<category id>": "<Group name> / <Category name>", "...": "..." } } } }

200 → { "id": "...", "model": "typesafe/jev-1.13-20260917", "provider": "TypeSafe",
        "answers": { "category": { "type": "choice", "choice": "<category id>",
                                   "probabilities": { "<category id>": 0.94, "...": 0.05 },
                                   "confidence": 0.94 } },
        "usage": { "input_tokens": 3150, "output_tokens": 2209, "cost": 0.0001323 } }
```

Facts measured with real calls: 57 options are accepted; a call takes 0.35 to
0.5 s; a question the model declines comes back as `{ "type": "refusal" }`.
Question keys and option keys: 1 to 64 characters of ASCII letters, digits,
`_`, `-` (a uuid fits). Without the payee's past categories Jev can be
confidently wrong (a supermarket read as a bakery at 91%); with them it was
right. So the payee's history is always sent.

## What is broken today (fix all of it)

- `api`: `bunx tsc --noEmit` fails in `src/categorize/store.ts`
  (`CategorizeFailureKind` is not defined).
- `client`: `bunx tsc --noEmit` fails with about 155 errors. The root is
  `src/budget/data/api/categorize.ts:66`, which injects into a slice named
  `aiApi` that does not exist; it must inject into the slice the other area
  files use. Most other errors disappear with that one.
- There is no way to produce suggestions: nothing calls a model, there is no
  run job and no endpoint to start a run or read its progress, and the page
  has no Run button and no state for "not configured".
- Some tests in `api/src/categorize/` expect suggestions that nothing seeds
  any more, and some counts in tests and `docs/architecture.md` are stale.

## What to build

1. **The Jev call**: `api/src/categorize/jev.ts`, about 50 lines. One function
   that takes the transaction facts, the payee's past categories and the
   category options, makes the one `fetch` above with a timeout, validates the
   answer with one zod schema, and returns the categories sorted by
   probability (top three used). A refusal, another answer type, a schema
   mismatch, a non-2xx or a timeout is a failure with a named kind; it never
   becomes a guess.
2. **The keys** (two sources, same pattern as the Pluggy credentials in
   `api/src/connections/`: read how those are stored and resolved and follow
   it):
   - **Server key**: one env var, `JEV_API_KEY`, used only by this feature.
     Add it to `.env.schema` with a comment that it holds an OpenRouter key
     for Jev. It is available to users only when the feature flag
     `shared-jev-key` is on (flags live in `shared/src/features.ts`; follow
     the existing ones).
   - **A user's own Jev key**: saved on the server, one per user, sealed with
     `core/secret-box` in a new table (additive migration `0123` or higher
     plus its `MIGRATION_SIGNATURES` entry). Never returned by any endpoint
     after saving; only "saved, ends in ••••1234, saved at".
   - Endpoints (contracts in a new `shared/src/contracts/jev/` barrel, added
     to `api/src/catalog.ts`; not exposed on MCP): get key status, save key
     (the server makes one real, tiny Jev call to check the key before
     storing it and refuses a key Jev rejects), test the saved key, remove key.
   - Resolution for a run: the budget owner's own key if they have one,
     whoever starts the run; otherwise the server key if the flag is on and
     the env var is set; otherwise "not configured" with a reason code the
     page can explain (no own key and flag off / flag on but server key
     missing). A key Jev rejects during a run stops the run with a clear
     failure kind; it is not retried per transaction.
   - Error messages from Jev are passed through a redaction step so a key can
     never appear in a log, a job record or a response.
3. **The run**: a background job `categorize_run` (Temporal, same pattern as
   the other jobs in `api/src/jobs/`). It selects the budget's transactions
   that need a category (use the shared rule in
   `shared/src/domain/category-needs.ts`; never transfers; never ones the
   owner already decided or skipped; never ones that already have pending
   suggestions), at most 100 per run. For each: read how the same payee was
   categorized before (last few, one SQL query), call Jev with the budget's
   assignable categories, store the top three in `category_suggestions`
   (`source = 'jev'`, `provider = 'jev'`, `model` = the model id, `confidence`
   = the probability, `reason` = null) and record the attempt in
   `categorize_attempts`. A few calls in parallel, not all at once. Use the
   existing store functions where they fit; schema changes only if truly
   needed, additive, per `AGENTS.md`.
4. **Endpoints**: `categorize_run_start` (not exposed on MCP) and
   `categorize_run_status`, as contracts in `shared/src/contracts/categorize/`
   with handlers in `api/src/categorize/`, plus the samples the catalog and
   access tests require. Status says: configured or not, running or not,
   done / total, failures.
   Run behaviour that must hold: a run is asynchronous and survives a worker
   restart; only one run per budget at a time (starting a second returns the
   running one); progress is readable while it runs; a transaction whose call
   failed is retried by a later run, with a cap on attempts per transaction;
   a transaction whose facts changed since its suggestions were made gets new
   ones; a skipped transaction is never sent on a timer, only when the owner
   starts a run that includes it by their action; the run never writes a
   category on a transaction, only suggestions.
5. **The Jev key screen** (new client feature `client/src/features/jev-key/`,
   route `jev-key`, a row in Settings): title "Jev API key", field label
   "Jev API key", help text that says the key is an OpenRouter key used for
   Jev, is stored encrypted on the server and never shown again. Actions:
   save, test, remove. States: no key, saved (masked ending and date),
   checking, rejected by Jev, server key in use (flag on, no own key). No
   provider choice and no model choice anywhere. English and pt-BR; "Jev" is
   not translated.
6. **The page** (`client/src/features/categorize/`): a Run button with a
   confirmation that says how many transactions will be sent, live progress,
   failures summary; an empty state; a "not configured" state whose text says
   explicitly "Jev API key" and links to the key screen. No reason line (Jev
   gives none). Keep the existing queue, bundle accept, one-by-one, undo,
   skip and threshold behaviour, on web and at phone width.

## Checks (all must pass; paste the output)

- `shared/`, `api/`, `client/`: `bunx tsc --noEmit` and `bunx eslint .` clean.
  (If client `tsc` fails only inside `.expo/types/router.d.ts`, say so; that
  file is generated.)
- `bun test` green in `shared/` and `client/`; in `api/` with
  `BUDGET_REQUIRE_TEST_DB=1 BUDGET_TEST_PG_BASE=postgres://postgres:postgres@localhost:55432`.
- Unit tests for the Jev call with a stubbed `fetch`: good answer, refusal,
  wrong shape, non-2xx, timeout.
- Run tests with a stubbed Jev call: a run writes the top three with the
  probabilities; a failure writes no suggestion and records the attempt; a
  second run does not call Jev again for a transaction that already has
  suggestions; a transfer is never sent; payee history is in the request.
- Key tests: save stores a sealed value and no endpoint ever returns the key;
  a key Jev rejects is not stored; remove deletes it; resolution order (own
  key, then server key only with the flag on, then not configured with the
  right reason); a shared budget uses the budget owner's key; a rejected key
  mid-run stops the run; a key planted in an error message is redacted.
- Run tests also cover: one run per budget at a time; attempt cap; changed
  transaction gets new suggestions; skipped transaction not sent on its own.
- One live smoke test, skipped unless `JEV_API_KEY` is set, that makes one
  real call with made-up data and checks the answer parses.
- `grep -rn "aiApi" client/src` finds nothing.

## Order

Server first (items 1 to 4), stop and report with the check output. Then the
key screen and the page (items 5 and 6), stop and report. Do not start the app or any server; tests
only.
