# Budget: migration analysis and plan

Source: `../syscd-app` at `8e79a31` (2026-11-17). Target: this repo (`budget/`).
Nothing in `syscd-app` changes until the final, separately approved phase.

Status (2026-11-18): phases 0 to 5 (5a to 5e) are complete and merged on `main`.
Phase 6 (deploy) is partly done: release `2026.11.18-01` is built and declared in
home-systems, but the app cannot start until the owner creates its secrets
(`docs/MORNING.md`); the iOS pass and cutover are open. Phase 7 (remove budget
from syscd-app) has not started and needs its own approval.

Evidence comes from three read-only audits of `syscd-app` (client module,
server, build/infra). File references below are paths in `syscd-app` unless
they start with `client/`, `api/`, `shared/` or `admin/`. Items the audits could
not confirm are listed under [Not verified](#not-verified).

## 1. Summary

- Budget is already close to a standalone product. The client module needs
  about 1.9k lines of `core/`, two symbols from the profile module, one icon
  component and the server contracts. No other module imports budget code.
- The server side is budget + connections + rates (about 9.1k of 17k non-test
  server lines) on top of a platform layer (auth, OAuth, MCP, CLI, jobs) that
  is feature-agnostic and copies almost unchanged.
- The hard parts are not code volume. They are: one shared `users` table, one
  shared migration sequence, a new app/API identity (hosts, cookie, Google
  redirect, Pluggy webhook), and sharing pure code between frontend and API
  without a root `package.json`.
- Approach: **copy first, reach parity, then refactor.** Lift-and-shift with
  no behaviour change (phases 0-4), then the structural refactors as separate
  steps (phase 5), then data cutover (phase 6). The schema-affecting refactors
  are the only ones that must land before cutover.

## 2. Scope and assumptions

| # | Assumption | Why | If wrong |
|---|---|---|---|
| A1 | The API moves too: `budget`, `connections`, `rates` plus the platform (`core`, `user`, `oauth`, `mcp`, `cli`, `jobs`) and `admin`. | A client-only repo keeps budget hostage to the syscd deploy and needs two PRs per API change. The platform is about 5.7k stable lines; forking it is cheaper than packaging it. | Phases 2, 4, 6 shrink to "point `client/` at `api.syscd.live`"; `shared/` becomes a vendored copy of the contracts. |
| A2 | No root `package.json`. Each top-level directory is a self-contained package. | Requested. | — |
| A3 | Fresh git history, with the source commit recorded in the first commit message. | "Start the repo plainly"; the history stays readable in `syscd-app`. | Use `git filter-repo` on a clone instead of copying files in phases 1-3. |
| A4 | New database on the same Postgres instance, squashed baseline, one-time data copy. | The migration sequence cannot be filtered per feature. | Sharing the database keeps two apps contending over one `schema_migrations` table. |
| A5 | iOS + web only. Android stays out. | It is configured but has never been built or tested. | Add an Android EAS profile and a test pass in phase 6. |
| A6 | syscd keeps working unchanged through the whole migration; removing budget from it is a later decision. | "Don't change code here." | — |

## 3. What moves, what is replaced, what is dropped

### Client

| Source | Lines | Fate |
|---|---|---|
| `modules/budget/**` | 41.1k (7.4k tests) | Moves. Reorganised in phase 5. |
| `app/budget/*` (12 stubs) | — | Become the root routes; `/budget/...` literals are rewritten. |
| `modules/auth` (`LoginGate`, `useAuth`, `nativeAuth`), `core/storage/sessionToken.ts`, `core/api/useAuthHeaders.ts` | ~290 | Moves. `LoginGate` needs `themed-text` replaced. |
| `modules/profile` (`useMe`, `MeAvatarButton`, `/profile`, `/connected-apps`) | ~800 | Moves, as a feature folder. |
| `core/avatar` | ~570 | Moves. |
| `core/api/{baseQuery,contractRequest}`, `core/di`, `core/storage`, `core/config`, `core/state/listeners*`, `core/ui/{portal,combobox}`, `core/import`, `core/date` | ~600 | Moves into `client/src/platform` and `client/src/ui`. |
| `core/apps/AppsSwitcher` | 405 | **Rewritten.** The app list is dead in a single app; the pane-stack menu (`MenuPane`, `useMenuNav`, `openBudget`) hosts budget's whole settings UI and becomes a budget settings menu. This is the one non-trivial shell rewrite. |
| `core/state/store.ts`, `core/module/*` | — | Replaced by a static `configureStore`. Keep `resetAppState` and the focus/reconnect listeners. Removes 32 `as unknown as BudgetUiRootState` casts. |
| `components/ui/icon-symbol`, `rn-web-events.d.ts` | — | Moves (desktop-web right-click menus need the type shim). |
| `core/logger`, `core/version` use by budget, `modules/mock`, `(tabs)` shell, Expo template components, `public/__harness.html` | — | Dropped. |
| Tamagui (provider, babel plugin, config) | — | Dropped. Budget uses only `useMedia` in one file; the compiler and runtime are on different majors today. Replace with `useWindowDimensions`. |

### Server

| Source | Lines (src/test) | Fate |
|---|---|---|
| `server/budget` | 5.6k / 5.2k | Moves. |
| `server/connections` | 3.5k / 3.5k | Moves; merged with budget into one bounded context in phase 5. |
| `server/rates` | 112 / 4 | Moves. |
| `server/core`, `user`, `oauth`, `mcp`, `cli`, `jobs` | 5.7k / 3.4k | Moves (forked platform). Rebrand: CLI name, credentials dir, MCP server name, cookie name. |
| `admin/` | 590 | Moves (follows `jobs`). |
| `db/migrations` (33 files) | 1.4k | **Not copied.** Replaced by one squashed baseline. |
| `scripts/` (`test-db-preload`, `release-*`, `e2e-{connections,consent,jobs,mcp}`) | — | Moves, trimmed. `etl-usda-health` stays. |
| `server/{health,ourtube,yt,ai}`, yt-dlp/python in the API image, health seed CSVs | — | Stay in syscd. |

### Docs and tooling

Move: `budget-engine-spec.md`, `budget-test-audit.md`,
`category-bundles-design.md`, `ynab-parity-gap.md`, `jobs-temporal-design.md`,
`mcp-and-cli.md`, `docs/vendor/pluggy-agent-skills`, `docs/ynab-ref`, the three
`mocks/*.svg`, `design_draft.md`. `architecture.md` is rewritten, not copied.
Start fresh: task tracker, agent dot-directories, knowledge-graph outputs.
Never copy `data/` (personal bank statements).

## 4. Architecture gaps found

Ranked by what they cost during or after the move. "When" refers to the
phases in section 6.

### Must be settled before the baseline schema is frozen (phase 2)

| # | Gap | Evidence | Fix |
|---|---|---|---|
| G1 | No currency model. No currency column on accounts or transactions; Pluggy's `currencyCode` is carried and then dropped. A linked USD account would import as BRL. | `connections/types.ts:67,94`; only `budgets.currency_format` (migration 0004) | Add `accounts.currency` to the baseline, backfilled to the budget currency. Conversion behaviour can come later; the column cannot. |
| G2 | Schema state depends on runtime history: `budgets.owner_user_id` becomes NOT NULL through an `ALTER TABLE` inside a request path. | `budget/ownership.ts:91-95` | NOT NULL in the baseline; delete the runtime ALTER. |
| G3 | Migration sequence has a missing 0002, two 0017s, and a data migration (0010) that needs seed rows, worked around by a retry loop in the test preload. | `scripts/test-db-preload.ts:128-155` | Squashed baseline removes all three. `MIGRATION_SIGNATURES` in `core/migrate.ts` goes with it. |

### High

| # | Gap | Evidence | Fix | When |
|---|---|---|---|---|
| G4 | Pure code is shared by relative imports in both directions: the client imports server contracts, the server imports `modules/budget/domain/{payees,transfers}`. | `modules/budget/data/api.ts:24-91`; 9 server imports | `shared/` (section 5). | 1 |
| G5 | Budget and connections are one bounded context split by lint only. Sync hand-writes inserts into `transactions` and `payees` and re-implements `loadRenameRules` and `upsertPayee`. Budget reads `connection_transactions`. | `connections/sync.ts:108-148,351,420,465`; `budget/domain/card-payments.ts:121,157` | One `ledger` write API owned by budget that sync calls; delete the mirrored helpers. | 5b |
| G6 | No store layer in the budget server: 205 `.query(` calls and 24 hand-rolled BEGIN/ROLLBACK blocks inside route files; business logic exported from routes. | `routes/transactions.ts` (580), `budgets.ts` (511), `accounts.ts` (448) | `withTransaction` helper in `core`; per-area store modules; routes become thin. | 5b |
| G7 | Money units differ by direction: writes take cents, reads return milliunits, `×10` and `/10` are scattered through handlers. | `routes/transactions.ts:77-78,268,414,430` | Milliunits everywhere on the wire. Breaking API change, done while the API host is new anyway. | 5d |
| G8 | Screens hold the application logic, untested: 21.5k lines with 31 lines of tests. `PlanScreen` is one ~1,400-line function with 32 `useState`; `AccountsScreen` has 21. These are also the churn leaders. | `screens/PlanScreen.tsx:236-1605`, `AccountsScreen.tsx:109-1454` | Extract `usePlanDrag`, `usePlanRowMenus`, `useRegisterFilter` and pure selectors, with tests, before moving files into feature folders. | 5e |
| G9 | `data/api.ts` is one 1,228-line slice. Response types are hand-maintained in `rows.ts` and `connections.ts` because contracts have no output schema; 13 endpoints still hand-write URLs. | `data/api.ts`, `data/rows.ts`; `operation-contract.ts:31-53` | Add `output` to `defineOperation`; derive client types; split the slice with `injectEndpoints` per area. | 5c |
| G10 | `domain/` is not a clean layer: it imports `data/` (cycle), `@core/avatar/types`, and holds module-level mutable singletons, so `formatMoney` is impure. | `domain/linkPicker.ts:9-11`, `fmtPrefs.ts:33`, `format.ts:59` | Wire types leave `domain/`; formatters take prefs as an argument. | 5a |
| G11 | Identity is syscd-shaped and read from env inside features: cookie domain, app origin, and the native scheme allowlist default in code. | `user/authz.ts:15-20,240-249`, `user/google.ts:13-64` | Auth config object injected from the entrypoint, like `OAuthConfig`. | 2 (minimal), 5b |
| G12 | `bun.lock` resolves 1,400 packages through a private npm proxy with no registry setting in the repo. | `bun.lock` | Generate new lockfiles against npmjs. Never copy the lockfile. | 0 |

### Medium

| # | Gap | Fix | When |
|---|---|---|---|
| G13 | The transactions contract still accepts client-supplied balance `deltas` "applied verbatim"; the app no longer sends them. Any CLI or MCP caller can corrupt balances. | Remove the field. | 2 |
| G14 | `budgetAccess` only inspects `budget_id` in query or body, never path params; each `/:id` handler re-scopes by convention. | Resolve the budget from the row for path-param routes in one place; add a catalog test. | 5b |
| G15 | Budget repeat-rule tick is an in-process `setInterval` in every API pod, while connections sync uses Temporal. | Temporal schedule, like `connections-sweep`. | 5b |
| G16 | `core/` leaks feature knowledge: budget schemas in `validate.ts`, `DATABASE_URL` read at import in `db.ts`. | Move schemas to budget; pool created by the entrypoint. | 5b |
| G17 | Freshness is coarse: tags per budget and type, the whole ledger loaded per budget, a 10 s revision poll that invalidates all 11 tag types, last write wins. | Entity-level tags and a paged transactions query. Budget arithmetic stays client-only for now. | after 6 |
| G18 | Four state mechanisms (redux slice, RTK Query cache, domain singletons, KV settings blob) with hand-rolled sync; display prefs are device-local. | Prefs in the slice, persisted by one listener; singletons deleted with G10. | 5e |
| G19 | Duplicated helpers: `monthOfDate` ×3, `milliToCents` ×2, `daysInMonth` ×2, `pairTransfers` ×2, `categoryLabel` ×3, and a second money formatter hard-coded to pt-BR that ignores the user's format preference. | One definition each; the pt-BR formatter is a user-visible bug. | 5e |
| G20 | Two engines: `domain/engine.ts` and `domain/zeroSum.ts` both claim to be canonical. | Confirm which is canonical before touching either. | 5a |
| G21 | CI never builds the web app, runs `expo-doctor`, or runs the four e2e scripts. | Per-directory CI jobs (phase 4). | 4 |
| G22 | Session token is stored in AsyncStorage rather than the Keychain. | `expo-secure-store` on native. | 5e |
| G23 | No i18n layer; English UI with stray Portuguese strings in `PlanScreen`. | Fix the strays now; an i18n layer only if a second locale is wanted. | 5e |

### Low

Dead code (`domain/import.ts`, `domain/seed.ts` and `zeroSum.fixtures.ts` are
test-only, `.ctc-write-test`), catch-all files (`ui/bits.tsx` 776,
`ui/MenuPanes.tsx` 875), 92 hex literals outside `theme.ts`, two diverged theme
files, `xlsx` from a CDN tarball, no error codes in API errors, no OTA updates.

## 5. Target layout

No manifest at the root. Four packages, each with its own `package.json`,
`bun.lock`, `tsconfig.json` and lint config, so each can be installed, typed,
tested and built from its own directory.

```
budget/
  README.md  AGENTS.md  Taskfile.yml  mise.toml  docker-compose.yml
  .env.schema  .gitignore  .github/workflows/
  docs/
  deploy/                 Dockerfiles, httpd.conf, image-tag values
  client/                 Expo app: iOS + web
    package.json  app.config.ts  eas.json  metro.config.js  babel.config.js
    assets/
    src/
      app/                Expo Router routes only (thin stubs)
      shell/              responsive rail / drawer / tabs, settings menu host
      features/           one directory per product area
        plan/  accounts/  banks/  payees/  import/  backup/
        reflect/  spending/  settings/  auth/  profile/
      domain/             client-only pure logic (engine, targets, people, format)
      data/               RTK Query slices per area, mapping, wire types
      state/              store, budgetUi slice, plan-edit history
      ui/                 theme, primitives, combobox, avatar
      platform/           api base query, di, storage, config, file picker
  api/                    Bun + Hono API, worker, CLI, stdio MCP
    package.json  bunfig.toml
    db/migrations/  db/seed/
    scripts/
    src/
      index.ts  worker.ts  cli.ts  mcp.ts  app.ts  catalog.ts
      core/  user/  oauth/  mcp/  cli/  jobs/
      budget/             contracts live in shared/; routes, store, domain here
      connections/
      rates/
  admin/                  Vite SPA for the jobs ledger (already its own package)
  shared/                 pure TypeScript used by client, api and admin
    package.json          dependency: zod only
    src/
      operation-contract.ts
      contracts/          budget/ connections/ rates/ user/ oauth/ jobs/
      domain/             payees.ts  transfers.ts  (+ what both sides need)
      zod.ts              the one zod export
```

Rules, lint-enforced where possible:

- `client/src`: `app → features → {domain, data, state, ui} → platform`.
  A feature never imports another feature's internals. `domain/` imports
  nothing but `shared/`.
- `api/src`: unchanged from today (feature → `core` and other features'
  barrels), minus the seams that phase 5b removes.
- `shared/` imports only zod. No React, no hono, no pg.
- `client/` and `api/` never import each other.

### Sharing code without a workspace

A root `package.json` is what makes workspaces work, so `shared/` is consumed
as source instead:

- `tsconfig` path `@shared/*` → `../shared/src/*` in `client/`, `api/`, `admin/`.
- Metro: `watchFolders: ['../shared']`. Bun and Vite resolve tsconfig paths
  natively.
- **The one real problem is bare imports from `shared/` files.** A file in
  `shared/src` that imports `zod` is resolved by walking up from `shared/`,
  which never reaches `client/node_modules` or `api/node_modules`. So `shared/`
  owns zod: it has its own `package.json` and `node_modules`, re-exports zod
  from `shared/src/zod.ts`, and `client/` and `api/` import zod only through
  it. One zod instance per runtime, and a lint rule bans direct `zod` imports
  elsewhere.
- Phase 0 found that `@modelcontextprotocol/sdk` (api) and
  `eslint-plugin-react-hooks` (client) pull in zod as a dependency anyway, so
  `api/` and `client/` add `"overrides": { "zod": "link:../shared/node_modules/zod" }`.
  This keeps one physical zod, and it means `shared/` must be installed first.
  See `decisions.md`.
- Costs: `bun install` runs in each directory (one Taskfile task), Docker build
  contexts are the repo root, and EAS runs from `client/` with the repo root
  uploaded.

This is the riskiest structural choice in the plan, so phase 0 proves it before
anything is copied. Fallbacks, in order: (1) `client/` and `api/` depend on
`shared` with `file:../shared`, which copies it into their `node_modules` and
resolves zod normally, at the cost of a re-sync step after every shared edit;
(2) accept a root `package.json` with workspaces.

## 6. Phases

Each phase ends in a state that runs and is committed. Phases 0-4 change no
behaviour: any diff from syscd found there is a bug in the move.

### Phase 0: start the repo plainly, prove the layout

1. `git init`; add `README.md`, `.gitignore`, `mise.toml` (node 26, bun 1.4.4),
   `Taskfile.yml`, `docker-compose.yml` (Postgres 18 + Temporal dev server, own
   volume and container names so nothing collides with syscd), `.env.schema`.
2. `client/`: `create-expo-app` on SDK 58 with the same React Native, router
   and reanimated versions as syscd; routes under `src/app`; `typedRoutes` and
   `reactCompiler` on; web output `single`. New slug, scheme and bundle id.
3. `api/`: `bun init`, hono, one hello operation. `shared/`: `operation-contract.ts`
   and the hello contract.
4. Lockfiles generated against npmjs (G12).
5. Spike the shared-source setup end to end. The hello screen calls the hello
   contract through `shared/`.

Exit, all of which must pass:

- `expo export --platform web` and an iOS simulator build both bundle `shared/`.
- `bun test` and `tsc --noEmit` pass in `client/`, `api/`, `shared/`.
- The MCP SDK accepts a zod schema that came from `shared/`'s zod instance.
- The Temporal workflow bundle builds.
- The API image builds from the repo root.

If the spike fails, switch to fallback 1 and re-run the exit checks before
phase 1.

### Phase 1: shared contracts and domain

Copy `server/core/operation-contract.ts`, the six contract barrels (budget,
connections, rates, user, oauth, jobs) with their `domain/schemas.ts`, and
`modules/budget/domain/{payees,transfers}.ts` with tests into `shared/`.

Exit: `shared/` typechecks and its tests pass with no database.

### Phase 2: API lift-and-shift

1. Copy `core`, `user`, `oauth`, `mcp`, `cli`, `jobs`, `budget`, `connections`,
   `rates` and the entrypoints; rewrite imports to `@shared/*`. Entrypoints lose
   the OurTube ticks, health boot, yt and ai.
2. Baseline: migrate a scratch database with syscd's migrations, dump the
   schema for budget, connections, users, oauth and jobs tables, and commit it
   as `0001_baseline.sql` with G1 and G2 applied. Dev seed without health data.
3. Trim the test preload to the new baseline; keep the per-checkout test
   database naming under a new prefix.
4. Remove client-supplied `deltas` (G13). Inject auth config from the
   entrypoint for cookie domain, app origin and scheme allowlist (G11).
5. Rebrand the CLI name, credentials directory, MCP server name and cookie name.

Exit: the copied server test suites pass against the baseline; the four e2e
scripts pass locally; `describeOperationCatalog` passes.

### Phase 3: client lift-and-shift

1. Copy `modules/budget` into `client/src` keeping its internal directories
   (`domain`, `data`, `state`, `model`, `import`, `transfer`, `ui`, `screens`)
   for now. Copy the platform subset, auth, profile and avatar.
2. Static store; delete the module contract and registry.
3. Routes move from `/budget/*` to the root; rewrite the literals.
4. Extract the pane-stack menu from `AppsSwitcher` into the settings menu host.
5. Remove Tamagui.

Exit: copied client tests pass; `tsc` and lint clean; a side-by-side pass of
every screen against syscd on web (desktop, tablet, phone widths) and the iOS
simulator, both pointed at the same local data, with screenshots.

### Phase 4: admin, dev workflow, CI

1. Copy `admin/`.
2. `Taskfile.yml`: `install` (all four directories), `deps`, `run`, `test`.
3. CI, one job per directory: `shared` (tsc, test), `api` (tsc, lint, test
   against Postgres 18, e2e scripts), `client` (tsc, lint, test, `expo-doctor`,
   web export), `admin` (build), plus Docker build checks (G21).
4. Write `AGENTS.md` and a new `docs/architecture.md` for this layout.

Exit: CI green on a pull request; `task run` brings up the full local stack
from a clean clone.

### Phase 5: refactors

Independent steps, each its own change with tests. Order is by dependency, not
by importance.

- **5a. Domain purity.** Wire types out of `domain/`; formatters take prefs as
  arguments; break the `domain ↔ data` and `ui ↔ shell` cycles; settle the
  canonical engine (G10, G20).
- **5b. API structure.** `withTransaction` and a store layer (G6); the `ledger`
  write API and the budget + connections merge (G5); path-param access checks
  (G14); repeat tick to a Temporal schedule (G15); schemas and env reads out of
  `core` (G16, G11).
- **5c. Contract outputs.** `output` schemas on operations; client types
  derived; `rows.ts` deleted; `api.ts` split per area; error codes (G9).
- **5d. Money units.** Milliunits everywhere on the wire (G7). Lands together
  with the client change, before cutover, so there is only ever one public
  version of the new API.
- **5e. Client structure.** Extract hooks and selectors from `PlanScreen` and
  `AccountsScreen` with tests, then move screens into `features/*` (G8); one
  definition per helper and the pt-BR formatter bug (G19); prefs state (G18);
  split `bits.tsx` and `MenuPanes.tsx`; one theme file; Keychain token (G22);
  stray Portuguese strings (G23).

Exit per step: tests added for the code that moved; no screen regresses in the
phase 3 screenshot pass.

5a, 5d and the schema parts of 5b should land before phase 6. The rest can
follow cutover.

### Phase 6: deploy and cutover

1. New identities: hostnames, EAS project and App Store listing, Google OAuth
   redirect URIs, Pluggy webhook URL, secrets item, image names, the cluster
   application and routes in `home-systems`, Temporal namespace and task queue.
2. Data rehearsal: copy `users`, budget, connections, oauth and jobs tables
   from a production dump into the baseline schema. Check row counts per table
   and account balances against syscd, twice, on a scratch database.
3. Cutover: stop budget writes in syscd, final copy, switch, verify. Existing
   Pluggy items keep the old webhook URL, so the old host forwards or the items
   are updated.
4. Users sign in again on the new app (new bundle, new cookie). CLI and MCP
   clients log in again (the OAuth issuer is the API host).

Exit: production budget matches syscd's balances; bank sync completes a run;
MCP and CLI work against the new host.

### Phase 7: remove budget from syscd

Out of scope until explicitly approved, since it changes `syscd-app`: delete
`modules/budget`, `server/{budget,connections,rates}`, their migrations' tables
and routes, after a period of running both.

## 7. Open decisions

Recommended defaults are what the plan assumes.

| # | Decision | Recommended | Affects |
|---|---|---|---|
| D1 | Does the API move, or does the new app call `api.syscd.live`? | Move (A1). | Phases 2, 4, 6 |
| D2 | Hostnames: subdomains of `syscd.live` or a new domain? | Subdomains of `syscd.live`. A new registrable domain needs a new cookie domain and breaks the admin cookie assumption. | Phase 6 |
| D3 | Database: new database with a data copy, or the same one? | New database, same instance (A4). | Phases 2, 6 |
| D4 | Frontend directory name. | `client/` (`app/` would give `app/src/app`). | Phase 0 |
| D5 | Git history. | Fresh (A3). | Phase 0 |
| D6 | Drop Tamagui. | Yes. | Phase 3 |
| D7 | Android. | Not now (A5). | Phase 6 |
| D8 | Do the breaking wire change to milliunits (G7)? | Yes, before cutover. | Phase 5d |

## 8. Risks

| Risk | Mitigation |
|---|---|
| Shared-source resolution fails in Metro, EAS or the Temporal bundler. | Phase 0 spike with a named fallback; nothing is copied before it passes. |
| Two zod instances at runtime. | `shared/` is the only zod source; lint rule; the spike checks the MCP SDK case. |
| Platform fork diverges from syscd. | Accepted. Health and OurTube keep their copy; fixes are cherry-picked by hand. |
| Data copy loses or mis-links rows (placeholder people, members, avatars). | Two rehearsals with row-count and balance checks before the real cutover. |
| Refactoring during the move hides regressions. | No behaviour change until parity is shown in phase 3. |
| Pluggy items keep pointing at the old webhook host. | Forward from the old host or update the items; confirm where `webhookUrl` is set first. |

## Not verified

- Whether Bun's default linker and SDK 58 autolinking behave as expected in
  this layout: the phase 0 spike answers it.
- Whether the MCP SDK accepts schemas from a second zod instance.
- The `home-systems` chart, routes and the cluster's Postgres and Temporal
  topology.
- Reachability of the npm proxy the current lockfile points at.
- Where the Pluggy `webhookUrl` and Google redirect URIs are registered.
- The count of hard-coded `/budget/` route strings in the client.
- Whether the formatter copies in `transfer/tsv.ts` are deliberate (a
  locale-stable file format) before deduplicating them.
- Per-handler SQL scoping on every `/:id` route (spot-checked once).
- Whether the repeat-rule tick is safe under more than one API replica.
- Operation and line counts are grep-based and approximate.
