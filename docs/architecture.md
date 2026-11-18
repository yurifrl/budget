# Architecture

State of `main` after phase 4. Sections marked "in flux" will change in phases
3/5; do not rely on their internals.

## Packages

```
budget/
  shared/   pure TypeScript, zod only        (stable)
  api/      Bun + Hono API, worker, CLI, MCP (lifted from syscd, unchanged behaviour)
  client/   Expo SDK 58 app, iOS + web       (phase 3/5, in flux)
  admin/    Vite + React SPA, jobs ledger    (copy of syscd's admin)
  deploy/   Dockerfile.{web,api,admin}, httpd.conf
  k8s/      values.yaml: image tags ArgoCD deploys
  scripts/  release-bump, release-changelog, db-init, e2e-api
  .github/workflows/  ci, version, release
```

No root `package.json`; each package installs and runs on its own. Code is
shared as source: `@shared/*` maps to `shared/src/*` in every tsconfig, Vite
alias and Metro `watchFolders`. `shared/` owns the only zod; the other three
override `zod` to `link:../shared/node_modules/zod`, so `shared/` installs
first. Details and trade-offs: `docs/decisions.md`.

## shared/

`src/operation-contract.ts` (the contract type, `defineOperation`,
`inputLocations`, `OperationOutput`), `src/contracts/{budget,connections,rates,user,oauth,jobs}`
(one operation contract per endpoint: method, path, zod input and output;
budget and connections keep their response row schemas in `outputs.ts`),
`src/contract-request.ts` (the request builder every client uses),
`src/errors.ts` (`{ error, code }`), `src/domain/{payees,transfers}` (pure
logic both sides need), `src/validation.ts` (uuid, dates, `milliunitsSchema`,
`currencyCodeSchema`, `MONEY_UNIT_RULE`), `src/zod.ts`. Lint: only zod, no
React, hono or pg. Wire rules: every amount is integer milliunits with no
unit suffix (phase 5d); see `shared/README.md`.

## api/ (hono, pg, Temporal, MCP SDK)

Entrypoints in `src/`: `index.ts` (HTTP), `worker.ts` (Temporal worker +
outbox relay), `cli.ts`, `mcp.ts` (stdio). Features: `core` (db, migrate,
operation helpers), `user`, `oauth`, `mcp`, `cli`, `jobs`, `budget`,
`connections`, `rates`. `catalog.ts` lists every shared contract; the CLI and
MCP tools are generated from it. `core` imports no feature; a feature imports
another only through its `index.ts` (the remaining seams are the Temporal
workflow-bundle ones, listed in `decisions.md`). Postgres schema:
`db/migrations` (33 files shared with the running syscd database; new ones
start at `0100`). One image runs both the API and the worker
(`bun src/worker.ts`). Release version: `api/VERSION`.

- **Database.** `core/db.ts` exports one `pool` and reads no env: each
  entrypoint (and the e2e scripts, and the bun test preload) calls
  `configureDb({ connectionString })` before the first query; until then the
  pool rejects. `withTransaction(pool, fn)` is the only BEGIN/COMMIT/ROLLBACK
  helper (two hand-rolled blocks are left on purpose: connections sync and
  the jobs relay). `Queryable` = pool or checked-out client.
- **Budget layers.** `budget/routes/*` parse, authorise (`budgetAccess` via
  `budgetRouter`) and shape responses; `budget/store/<area>.ts` holds the SQL
  (functions taking a `Queryable` and typed params); `budget/domain/*` holds
  the rules (balance deltas, transfers, card payments, repeat-rule
  generation, category goals). Not every route file is migrated yet (see the
  phase 5b list in `decisions.md`).
- **Budget and connections.** Connections writes into budget's tables only
  through `ledger` (`budget/ledger.ts`, exported from the budget barrel):
  payee resolution with rename rules, imported-row insert/refresh/tombstone,
  balance deltas, card-payment pairing. Budget reads/writes the connections
  tables only through `connections/ledger-reads.ts` (connections barrel). The
  two barrels import each other; neither runs the other's code at load time.
- **Contracts at runtime.** `mountOperations` validates input; with output
  validation on (the bun test preload sets `throw`; `API_VALIDATE_OUTPUT=warn|throw`
  in local dev, ignored in a cluster) it also parses each handler result with
  the contract's `output`. `catalog-outputs.test.ts` calls every budget and
  connections read on seeded data and parses the answer. Errors are
  `{ error, code }` (`HttpError(status, message, code?)`, `errorResponse`).
  MCP tools advertise object outputs as `outputSchema`.
- **Money.** Handlers and storage both use milliunits; the only unit
  conversions left are at the Pluggy adapter (floats -> milliunits, once),
  the `category_targets` table (cents) and legacy backups
  (`upgradeRestorePayload`). `accounts.currency` (migration 0100) is an ISO
  4217 label, NULL = the budget's currency; bank sync fills it from the
  provider while it is NULL.
- **Access.** `budgetAccess` authorises the `budget_id` in query/body; path
  `:id` routes re-scope by `budget_id` in SQL. `src/access.test.ts` drives
  every path-param operation from the catalog as a non-member and expects 404.
- **Repeat-rule tick.** Still an in-process interval in the API
  (`BUDGET_REPEAT_TICK`, off in production); the generation code is
  `budget/domain/repeat-generation.ts`.

## client/ (in flux)

Expo Router app. As of phase 3: `src/app` routes, `store`, `budget`
(lifted syscd budget module), `auth`, `profile`, `shell`, `ui`, `platform`.
`budget/data` is the wire boundary: `data/api.ts` re-exports one RTK Query
api assembled from `data/api/{base,budgets,members,plan,payees,register,connections}.ts`
(`injectEndpoints`), every request built with `contractRequest`; `rows.ts`
and `connections.ts` are `z.infer` types of the contracts' output schemas;
`mapping.ts` converts wire milliunits to the domain's cents and back.
The lint-enforced layering is in `client/eslint.config.js`, with documented
phase 3 exceptions. The target structure (features/, domain/, data/, state/)
arrives in phase 5. `client/VERSION` feeds the Expo app version.

## admin/

Hash-routed SPA (`Runs`, `RunDetail`) over the `jobs_*` contracts from
`@shared/contracts/jobs`. API base URL: `VITE_API_URL` at build time, or a
`/config.json` `{ "apiUrl": ... }` mounted into the image at runtime.
Requests are built with `@shared/contract-request` (the copy is gone).

## Build, CI, release

- Images (context = repo root): web (Expo web export, busybox httpd :8080,
  `EXPO_PUBLIC_API_URL` build arg), api (+ worker), admin (`VITE_API_URL`).
- `ci.yml`: one job per package plus Docker build checks. The api job runs
  against a Postgres 18 service container, then `scripts/e2e-api.sh` (OAuth
  consent + MCP over HTTP; no Temporal).
- Release: `task release` bumps `api/VERSION` and `client/VERSION` and pushes
  main. `version.yml` writes the changelog section (OpenRouter notes if
  `OPENROUTER_API_KEY` is set, else the commit list), tags `v<VERSION>` and
  dispatches `release.yml`: push `ghcr.io/<owner>/budget-{web,api,admin}`
  (amd64 + arm64; tags version, sha, latest), then commit the version into
  `k8s/values.yaml` (`budget-worker` follows `budget-api`). ArgoCD rolls the
  Deployments from that file. The EAS build job exists but is off unless the
  repo variable `EAS_ENABLED` is `true`.

## Runtime hosts

web `https://budget.syscd.live`, API `https://budget-api.syscd.live`, admin
`https://budget-admin.syscd.live`. The API shares syscd's Postgres database
for now (hence the migration numbering rule).
