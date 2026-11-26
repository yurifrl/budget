---
title: Classifier restart: delete the AI part, rebuild on Jev only
date: 2026-11-26
description: Remove every AI-related line of the category classifier (provider layer, keys, flag, env vars, run engine, key screen), stop with the app broken for the owner to inspect, then rebuild on Jev alone.
tags: [categorize, ai, jev, delete, plan]
---

# Classifier restart

Owner's words: "i want the ai component part of the classifier completly
removed, and started over using jev, i dont want remenatns". No git until the
owner says otherwise: all work is uncommitted edits in the main checkout.

## Phase 1: delete (then STOP and show)

Deleted whole:

- `api/src/ai/` (five provider adapters, key resolution, credentials store,
  routes, env, settings, redaction).
- `shared/src/contracts/ai/`.
- `client/src/features/ai-keys/`, its route `client/src/app/(budget)/ai-keys.tsx`,
  its data slice `client/src/budget/data/api/ai.ts`, its Settings entry.
- In `api/src/categorize/`: the model run (agent, tools, chunk, messages,
  key-lock, job, jobspec, workflows, activities, fake provider, their tests)
  and the run endpoints (`categorize_run_start`, `categorize_run_status`).
- `api/scripts/e2e-categorize.ts`.
- Env vars `AI_SHARED_API_KEY`, `AI_SHARED_PROVIDER`, `AI_SHARED_MODEL` from
  `.env.schema`; feature flag `shared-ai-key`; admin setting `aiSharedModel`.
- AI sections of `docs/architecture.md`, `docs/decisions.md`; the old plan
  `.agents/plans/2026-11-25_categorization.md`.

Deleted line by line: every import, registration, string, test sample and
comment elsewhere that refers to the above. Nothing is stubbed or repaired:
the code is left broken.

Kept (not AI): the Categorize page, the queue, accept / undo / skip, the
threshold setting, the suggestion and decision tables. They will not compile
until phase 2.

Cannot be deleted without a decision: applied migrations (`0109_ai_credentials`
and the signature list in `api/src/core/migrate.ts`), because production
already ran them; released lines in `CHANGELOG.md`.

Check: a search of the repo (outside `node_modules`, `.tasks`, migrations,
CHANGELOG) for `AI_SHARED`, `shared-ai-key`, `ai_credentials`, `aiShared`,
`openrouter`, `anthropic`, `openai`, `deepseek`, `z.ai`, `ai-keys`, `AiKey`,
`ResolvedAi`, `providerFor` returns nothing. The typecheck fails, and the
list of failures is shown to the owner.

## Phase 2: rebuild on Jev (only after the owner has seen phase 1)

- One provider: Jev. No provider choice, no detection, no model list.
- One env var for the server key, used only by categorization: `JEV_API_KEY`.
- The key screen says "Jev API key" explicitly (title, field label, help text).
- First milestone is a real run against Jev on a few transactions, before
  anything else is built around it.
- Open: the exact Jev model id and endpoint (`typesafe/jev-1.13` from the
  owner's link; not yet confirmed callable), and whether users may still bring
  their own Jev key or only the server key exists.
