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
task lint         # eslint in shared, api, client, admin
task test         # shared, api (needs Postgres :5432), client, admin
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

1. Contract in `shared/src/contracts/<feature>/<file>.ts` via
   `defineOperation`: zod `input` AND `output` (the 2xx JSON body; `z.null()`
   for a 204; row schemas in that feature's `outputs.ts`), method, path, kind,
   expose. Money is integer milliunits with no unit suffix in the field name
   (`milliunitsSchema`; say so in the description). Export it from the
   feature's `index.ts` barrel if it is a new file. Add a test next to it.
2. Handler in `api/src/<feature>/`: `implement(contract, handler)` and mount it
   with `mountOperations` (see `api/src/rates/routes/rates.ts`); the router is
   mounted in `api/src/app.ts`. A new feature's contract barrel also goes into
   `api/src/catalog.ts`; the CLI and MCP tools are generated from the catalog.
   In `budget/`: the handler only parses, authorises and shapes the response;
   SQL goes in `budget/store/<area>.ts` (functions taking a `Queryable` from
   `core/db`), rules in `budget/domain/`, multi-statement writes in
   `withTransaction(pool, fn)`. A path `:id` must be re-scoped by `budget_id`
   in SQL, and a new path-param operation needs a sample in
   `api/src/access.test.ts` (the test fails until it has one); a new read
   needs a sample in `api/src/catalog-outputs.test.ts`. Tests check every
   handler result against `output` (a mismatch is a 500 in the test). Errors:
   throw `HttpError(status, message, code?)`; the body is `{ error, code }`.
3. Client: build the request with `contractRequest(contract, input)`
   (`@shared/contract-request`) from an RTK Query slice: budget endpoints go in
   the area file under `client/src/budget/data/api/` (`injectEndpoints`) and
   are re-exported from `data/api.ts`; type the response from the contract
   (`z.infer` of its row schema or `OperationOutput<typeof contract>`), never by
   hand.
4. New SQL: a migration `api/db/migrations/0100_*.sql` or higher, additive
   only, plus a `MIGRATION_SIGNATURES` entry in `api/src/core/migrate.ts`.

## Adding a client screen or feature

Layout and rules: `docs/architecture.md` ("client/"). In `client/src`:

1. Pick the feature (`features/<x>/`) or create one: a directory with an
   `index.ts` that exports what routes, the shell and other features may use.
   ESLint reads the feature list from disk; other code may import it only as
   `@/features/<x>`.
2. Screen component in `features/<x>/<Name>Screen.tsx`, exported from the
   barrel. Route: `src/app/(budget)/<route>.tsx` containing only
   `export { NameScreen as default } from '@/features/<x>';` (outside the rail:
   `src/app/<route>.tsx`, registered in `app/_layout.tsx`'s Stack).
3. Keep components small (aim: no function over ~300 lines, no file over
   ~600): stateful logic in `useXxx.ts` hooks next to the screen, pure rules
   in `domain/<name>.ts` (budget logic, no wire types, only `./` and
   `@shared/*` imports) or `<name>.logic.ts` next to the component (view
   logic, may use wire types); both with `*.test.ts` (no React renderer in
   the repo: test the pure part, keep hooks thin).
4. Data: RTK Query hooks from `@/budget/data/api`; store-backed hooks from
   `@/state/*` (`useBudgetModel`, `useBudgetMonth`, `useDisplayPrefs`); money
   and dates only through `useMoneyFormat()` (`@/ui/moneyFormat`), never a
   local `Intl` formatter; shell services through `useBudgetShell()`
   (`@/shell/context`); colors from `@/ui/theme`.
5. Shared widgets used by several features go to `ui/` (which may import
   only `domain/` and `platform/`). `src/architecture.test.ts` fails on import
   cycles. Run `bunx tsc --noEmit`, `bunx eslint .`, `bun test` in `client/`.

## Strings

Every user-visible string goes through the typed `t()` catalogs (English source
+ `pt-BR`); never hard-code UI text. Catalog format, the `t` API, the recipe,
the lint rule and its `i18n-enforced/*.json` manifests, the do-not-translate
list and the pt-BR glossary: `docs/i18n.md`.

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


<!-- BEGIN TK INTEGRATION v:0.7.1 hash:5afc551e -->
## Tasks Issue Tracker

This project uses **tk (Tasks)** for ALL task tracking — do NOT use markdown TODO lists, TodoWrite, or other trackers. Run `tk prime` for full workflow context.

### The loop — task → review

| status | who moves it | how |
|---|---|---|
| open | creator | `tk create "Change bg to blue"` — the title seeds the branch name |
| in-progress | agent | `tk work <id>` — claims, opens the work env (worktree + branch), and records both on the task |
| ready-to-review | agent | `tk finish <id> --session <sid>` — the single completion path into review |
| approved → closed | reviewer | `tk close <id> --reason "<report>"` |
| rejected | reviewer | comments land on the record; the loop restarts at `tk work <id>` |

**The contract: work in `tk work <id>` and commit there; finish with `tk finish <id> --session <sid>`; never mark done — the recorded worktree, branch, and derived diff are the evidence; wait for the verdict with `tk watch <id> --until "status=approved|rejected"`; review with `tk review <id>` and `tk comments <id>`.**

1. **Create** the task first: `tk create "title"` (or `tk q "title"` to capture and print only the id). One issue per deliverable; `--parent` for subtasks of an epic, `tk dep add <id> <blocker>` for blockers.
2. **Claim, then isolate.** `tk work <id>` claims the task and opens a worktree + branch (shared `.tasks/` workspace); the worktree path, branch, and pinned changeset base are recorded on the task as the evidence of work. Commit your work on that branch — commits are the evidence. Post progress with `tk note <id> "…"` as you go.
3. **Keep it updated with proof.** Attach the before state, then after-shots as you implement: `tk attach <id> --evidence <file>` (screenshots, logs, outputs survive file moves; reference them from comments as `evidence:<id>`).
4. **Hand over on the record.** `tk finish <id> --session <sid>` (or `TK_SESSION` env) stamps the session and finish time, derives the changeset from the recorded worktree/branch/base, and moves the task to `ready-to-review` — the single completion path. It prints a stat card (`N commits · +A −D · F files` plus the changes-view link) and, as its last line, the handoff line. Relay the stat card — never paste a diff into chat — then **end your message with the handoff line `tk finish` printed, unchanged** (it names every task your session has in `ready-to-review`; keep it outside code blocks so the link renders), e.g. `done, tasks to review → [tk review tk-a1b2 tk-c3d4](http://localhost:21579/tasks/tk-a1b2?review=tk-a1b2,tk-c3d4&ws=/path/to/repo)`. `tk changes <id>` reprints the card (stale counts from the finish report when the branch is out of reach), not the line. One PR per task: `tk pr create <id>` pushes the branch and opens it via gh (recorded on the task); `tk pr sync <id>` pulls its state — only when asked, never polled; `tk pr merge <id>` / `tk pr close <id>` act on it via gh and keep the branch (`tk close <id>` prunes). Never mark done by hand.
5. **Wait for the verdict, don't poll.** `tk watch <id> --until "status=approved|rejected"` blocks until the reviewer decides (`--until "type=task.comment"` for review comments; exit 124 = `--timeout`, default 30m, passed with nothing new); `tk watch <id> --drain` at session start prints what you missed.
6. **Report on close.** Review rides the record: `tk review <id>` reviews the recorded diff (`tk review a b c` reviews that ordered list as one bundle; `tk review` with no ids = every task in `ready-to-review`, a provisional default); `tk comments <id>` lists review comments (`tk comments resolve <id> <cid>` once addressed). Approved → `tk close <id> --reason "<what changed, where, evidence ids>"`; rejected → `tk work <id>` again, fix, `tk finish`, re-hand over. "Done" is a report on the record, not a chat message. Never close an issue whose acceptance criteria are not visibly met.

Lifecycle: `tk close` prunes the task's worktree and `tk/<id>` branch when merged and clean (a refusal is a note on the close line; the close still succeeds); `tk worktree clean` lists leftover worktrees of closed tasks, `--yes` removes them.

### End of session — print the work done

Before ending, update every touched task (status, notes, evidence), file follow-ups with `tk q`, then print a work-done summary: tasks touched with final status, what changed and where, the validation you ran, and evidence ids. The print mirrors the record; the record persists.

**Critical rules:**
- Explicit user or orchestrator instructions override this Tasks block.
- Don't gate the loop on chat: status changes and comments are the handoff; the record is the memory.
<!-- END TK INTEGRATION -->
