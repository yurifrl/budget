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
`inputLocations`), `src/contracts/{budget,connections,rates,user,oauth,jobs}`
(one operation contract per endpoint: method, path, zod input/output),
`src/domain/{payees,transfers}` (pure logic both sides need),
`src/validation.ts`, `src/zod.ts`. Lint: only zod, no React, hono or pg.

## api/ (hono, pg, Temporal, MCP SDK)

Entrypoints in `src/`: `index.ts` (HTTP), `worker.ts` (Temporal worker +
outbox relay), `cli.ts`, `mcp.ts` (stdio). Features: `core` (db, migrate,
operation helpers), `user`, `oauth`, `mcp`, `cli`, `jobs`, `budget`,
`connections`, `rates`. `catalog.ts` lists every shared contract; the CLI and
MCP tools are generated from it. `core` imports no feature; a feature imports
another only through its `index.ts` (a few seams are listed in
`decisions.md`). Postgres schema: `db/migrations` (33 files shared with the
running syscd database; new ones start at `0100`). One image runs both the API
and the worker (`bun src/worker.ts`). Release version: `api/VERSION`.

## client/ (in flux)

Expo Router app. As of phase 3: `src/app` routes, `store`, `budget`
(lifted syscd budget module), `auth`, `profile`, `shell`, `ui`, `platform`.
The lint-enforced layering is in `client/eslint.config.js`, with documented
phase 3 exceptions. The target structure (features/, domain/, data/, state/)
arrives in phase 5. `client/VERSION` feeds the Expo app version.

## admin/

Hash-routed SPA (`Runs`, `RunDetail`) over the `jobs_*` contracts from
`@shared/contracts/jobs`. API base URL: `VITE_API_URL` at build time, or a
`/config.json` `{ "apiUrl": ... }` mounted into the image at runtime.
`src/contractRequest.ts` is a local copy of the client's helper (follow-up:
move it to `shared/`).

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
