---
title: Classifier restart: delete the AI part, rebuild on Jev only
date: 2026-11-26
description: The old multi-provider AI layer of the category classifier is deleted. Rebuild it on Jev (TypeSafe's decision model, through OpenRouter's Decisions API) with one call per transaction, one env var, and as little code as possible.
tags: [categorize, jev, plan]
---

# Classifier restart on Jev

Owner's words: "i want the ai component part of the classifier completly
removed, and started over using jev, i dont want remenatns" and "leverage jev
in the least amount of lines possibly".

Standing rule for this work: no git until the owner says otherwise. All work is
uncommitted edits in the main checkout; nothing is pushed.

## Phase 1: delete (DONE 2026-11-26, shown to the owner)

Deleted: `api/src/ai/`, `shared/src/contracts/ai/`,
`client/src/features/ai-keys/` with its route, data slice and Settings row; the
model run in `api/src/categorize/` (agent, tools, job, workflow, activities,
candidate selection, errors); the run endpoints; env vars `AI_SHARED_*`; flag
`shared-ai-key`; the AI doc sections and the old plan.

State left behind: `shared/` compiles; `api/` has 1 type error
(`categorize/store.ts`, `CategorizeFailureKind`); `client/` has 155, nearly all
from one dangling line (`client/src/budget/data/api/categorize.ts:66`,
`aiApi.injectEndpoints`).

Still present, each waiting for the owner (see "Owner decisions"): migration
`0109_ai_credentials` and the table in production; the `'ai'` suggestion
source value; `provider` / `model` columns; 12 released CHANGELOG lines.

## What Jev is (verified by 17 real calls on 2026-11-26)

Jev is not a chat model: no tool calling, no text, no reasons. One request
carries a `state` and typed `questions`; a `choice` question returns a
probability for every option.

```
POST https://openrouter.ai/api/alpha/decisions      Authorization: Bearer $JEV_API_KEY
{ "model": "typesafe/jev-1.13",
  "state": { payee, bank_text, amount, date, account, same_payee_categorized_before_as: [...] },
  "questions": { "category": { "type": "choice",
      "instructions": "Which budget category does this bank transaction belong to?",
      "criteria": { "<category id>": "<Group> / <Category>", ... } } } }
→ answers.category = { type: "choice", choice, probabilities: { "<category id>": 0.94, ... }, confidence }
```

Measured: 57 options accepted; 0.35 to 0.5 s per call; $0.00013 per
transaction (about 13 cents per 1,000); 9 of 12 sample lines right at 100%,
2 honestly unsure, 1 confidently wrong (a supermarket read as a bakery at 91%)
that payee history in the `state` corrected. Probe scripts: session scratchpad
`jev/probe.ts`, `jev/probe2.ts`.

## Design

One sentence: for each uncategorized transaction, call Jev once with the
transaction, how that payee was categorized before, and the budget's
categories as the options; store the three most probable as suggestions with
the probability as the certainty.

Rules:

- Jev is the only provider. No provider choice, no detection, no model list,
  no adapter interface. The model id is one constant.
- One env var: `JEV_API_KEY` (it holds an OpenRouter key; Jev needs no other
  account). Used only by categorization.
- Payee history is always in the `state`: one SQL query, the payee's last
  categorized transactions.
- An answer that is a refusal, has another type, or fails the zod schema means
  "no suggestion", never a guess. A failed call is recorded as an attempt and
  retried on the next run.
- Nothing is applied automatically. The threshold and bundle accept work on
  Jev's probability, as before.
- No "reason" text anywhere: Jev gives none.
- Reuse what survived: `category_suggestions`, `categorize_attempts`,
  `categorize_decisions`, the queue, accept / undo / skip, the threshold
  setting, the Categorize page. No new table unless a task proves it needs one.

## Tasks (each: one tk task, delegated, independent review before it counts as done)

### J0 Accuracy on real data (before any building)

Take about 50 of the owner's transactions that already have a category, ask
Jev with the owner's real categories and payee history (excluding the
transaction itself), and count agreement overall and above 80%, 90%, 95%.
Needs the owner's yes: it sends real payee names and amounts to OpenRouter.
Check: a table of agreement by threshold, and a recommended default threshold.
If agreement above the chosen threshold is under 95%, stop and bring the
numbers to the owner before J1.

### J1 The Jev call (`api/src/categorize/jev.ts`, about 50 lines)

`suggestCategories(transaction, history, categories) → [{ categoryId, probability }]`
sorted, top three. One `fetch`, one zod schema for the answer, a timeout, the
key read from `JEV_API_KEY`. `.env.schema` gets `JEV_API_KEY` with a comment.
Check: unit tests with a stubbed `fetch` for a good answer, a refusal, a wrong
shape, a non-2xx and a timeout; one opt-in live test (skipped without the key)
that makes a real call.

### J2 The run (server)

Restore the smallest version of what was deleted: select uncategorized
transactions (the shared `needsCategory` rule; not transfers; not ones already
decided or skipped), read payee history, call J1, write suggestions and
attempts. Runs as the Temporal job `categorize_run`; endpoints
`categorize_run_start` and `categorize_run_status` come back. Fix the
`CategorizeFailureKind` error by defining the two or three failure kinds Jev
can produce. Cap per run stays 100 transactions; calls run a few at a time.
Check: api typecheck, lint and suite green; a test that a run over seeded
transactions writes the top three with Jev's probabilities; a test that a
refusal writes no suggestion; a test that a second run does not call Jev again
for a transaction that already has suggestions.

### J3 The key (server + screen)

Depends on owner decision 1. Minimum: the server key only, and the page shows
whether Jev is configured. If users bring their own key: one screen titled
"Jev API key", field label "Jev API key", help text naming Jev, no provider or
model controls; storage reuses `core/secret-box`.
Check: screenshots at 1400 and 375 in English and pt-BR where "Jev API key"
is visible in title and label; a search for "AI key" in the client finds
nothing.

### J4 Reconnect the Categorize page (client)

Fix the dangling `aiApi` line so the data slice compiles; bring back the Run
button and progress, and an empty state that says Jev is not configured;
remove the reason line. All strings through `t()` in English and pt-BR.
Check: client typecheck, lint and suite green; screenshots of the page with
suggestions, running, empty and not configured.

### J5 Real run, end to end

On the local app with a copy of real data: start a run, see suggestions with
certainties, bundle accept above the threshold, accept one by one, undo.
Check: a screen recording or screenshots of each step; the run's cost from
`usage.cost` matches the estimate.

## Owner decisions

1. Keys: server key only (`JEV_API_KEY`), or may users also save their own Jev
   key?
2. J0 sends about 50 real transactions (payee, bank text, amount) to
   OpenRouter: yes or no.
3. The `ai_credentials` table in production and migration 0109: leave, or drop
   with a new migration (touches production).
4. The `'ai'` suggestion source value and the `provider` / `model` columns:
   keep the names, or rename to `jev` (existing production rows would need an
   update).
5. Model: `typesafe/jev-1.13` (the owner's link) or `typesafe/jev-1.14` (newer,
   same API; price not checked).

## Done means

- J0 to J5 done with their checks green and an independent review with no open
  blocker.
- The whole Jev integration is one file plus the run; a search of the repo for
  `openrouter`, `anthropic`, `openai`, `deepseek`, `AI_SHARED`, `shared-ai-key`
  outside release-notes tooling, migrations and CHANGELOG finds nothing.
- The owner has run it on their own budget and seen suggestions they agree
  with.
