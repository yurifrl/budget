# Budget: agent guide

Personal budgeting app moved out of syscd-app. Layout and decisions:
`docs/architecture.md`, `docs/decisions.md`, plan in `docs/migration-plan.md`.

## Layout and import rules

No root `package.json`. Four packages, each with its own `package.json`,
`bun.lock`, `bunfig.toml` (npmjs registry), `tsconfig.json`; install, test and
typecheck from inside the directory.

| Dir | What | May import |
|---|---|---|
| `shared/` | zod contracts, pure domain, validators | zod only (via `src/zod.ts`). No React, hono, pg |
| `api/` | Bun + Hono API, worker, CLI, stdio MCP | `@shared/*`, own code |
| `client/` | Expo app (iOS + web) | `@shared/*`, own code |
| `admin/` | Vite SPA for the jobs ledger | `@shared/*`, own code |

- `@shared/*` is a tsconfig path to `../shared/src/*` (Bun, Vite and Metro read it).
- Import zod only from `@shared/zod` (lint bans `zod` elsewhere). api, client
  and admin override zod to `link:../shared/node_modules/zod`, so **install
  `shared/` first** (`task install` does).
- `client/` and `api/` never import each other. `api/src`: features import
  `core` and other features through `index.ts` only (lint-enforced).
- Lockfiles must resolve from registry.npmjs.org (no `fbr.land` URLs).

## Commands

```
task install      # shared first, then api, client, admin
task typecheck    # tsc --noEmit in all four
task lint         # eslint in shared, api, client
task test         # shared, api (needs Postgres :5432), client
task test:e2e     # api e2e without Temporal (scripts/e2e-api.sh)
task deps         # Postgres (reuse :5432 or compose :55432) + Temporal :57233
task run          # api :3100, worker, admin :5191, web :8091 (after `task deps`)
task admin:build  # admin production build
task release      # bump api/VERSION + client/VERSION, push main (CI does the rest)
```

Docker images (context = repo root): `deploy/Dockerfile.{web,api,admin}`. On
this Mac use `container build --dns 1.1.1.1 -f deploy/Dockerfile.<x> -t budget-<x>:dev .`
(the `docker` shim has no DNS).

## Adding an endpoint

1. Contract in `shared/src/contracts/<feature>/<file>.ts` (zod input/output,
   method, path, via `defineOperation`), exported from that feature's `index.ts`
   barrel if it is a new file. Add a test next to it.
2. Handler in `api/src/<feature>/`: `implement(contract, handler)` and mount it
   with `mountOperations` (see `api/src/rates/routes/rates.ts`); the router is
   mounted in `api/src/app.ts`. A new feature's contract barrel also goes into
   `api/src/catalog.ts`; the CLI and MCP tools are generated from the catalog.
   In `budget/`: the handler only parses, authorises and shapes the response;
   SQL goes in `budget/store/<area>.ts` (functions taking a `Queryable` from
   `core/db`), rules in `budget/domain/`, multi-statement writes in
   `withTransaction(pool, fn)`. A path `:id` must be re-scoped by `budget_id`
   in SQL, and a new path-param operation needs a sample in
   `api/src/access.test.ts` (the test fails until it has one).
3. Client: build the request with `contractRequest(contract, input)`
   (`client/src/platform/api/contractRequest.ts`) from an RTK Query slice, e.g.
   under `client/src/budget/data`.
4. New SQL: a migration `api/db/migrations/0100_*.sql` or higher, additive
   only, plus a `MIGRATION_SIGNATURES` entry in `api/src/core/migrate.ts`.

## Shared machine rules

- Never bind or stop syscd-app's ports: 3000, 8081, 5174, 5432, 7233, 8233.
  This repo uses api 3100, Metro 8091, admin 5191, compose Postgres 55432,
  Temporal 57233 / UI 58233, e2e API 3190.
- Postgres on :5432 is shared. Only databases named `budgetnew_*` are ours
  (`budgetnew_dev`, `budgetnew_test[_<hash>]`, `budgetnew_e2e`). Never touch
  others. Drop test databases you create.
- Never `pkill`/`killall`; kill only PIDs you started.
- Tests that need the DB: `BUDGET_REQUIRE_TEST_DB=1` (set by `task test:api`)
  makes a missing DB a failure rather than a skip.

## Tasks Issue Tracker

This project uses **tk (Tasks)** for ALL task tracking. Do not use markdown
TODO lists or other trackers.

| status | who moves it | how |
|---|---|---|
| open | creator | `tk create "title"` (or `tk q "title"`, prints only the id) |
| in-progress | agent | `tk work <id>` claims it and opens a worktree + branch |
| ready-to-review | agent | `tk finish <id> --session <sid>`, the single completion path |
| approved, closed | reviewer | `tk close <id> --reason "<report>"` |
| rejected | reviewer | comments land on the record; restart at `tk work <id>` |

- Work in the `tk work` worktree; never mark done by hand.
- Post progress with `tk note <id> "..."`; attach proof with
  `tk attach <id> --evidence <file>`.
- File follow-ups with `tk q`. Never close a task whose acceptance criteria
  are not visibly met.
- Explicit user or orchestrator instructions override this block.
