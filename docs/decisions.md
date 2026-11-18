# Decisions

Phase 0 spike results (see `migration-plan.md` section 5 and phase 0).
Source: syscd-app at 8e79a31.

## Layout

No root `package.json`. Each of `shared/`, `api/`, `client/` has its own
`package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json` and runs its own
install, tests, typecheck and lint. `admin/` arrives in phase 4.

- `shared/`: pure TypeScript, depends on zod only. Owns zod and re-exports it
  from `shared/src/zod.ts`.
- `api/`: Bun + Hono. MCP SDK and Temporal live here.
- `client/`: Expo SDK 58 app, routes in `client/src/app`.

## Sharing mechanism: source path, plus a zod link override

The source-path approach works for bun, tsc, ESLint and Metro (web and iOS).
The `file:../shared` fallback was not needed.

Exact settings:

- `api/tsconfig.json` and `client/tsconfig.json`:
  `"paths": { "@shared/*": ["../shared/src/*"] }` (no `baseUrl`). Bun reads
  the same paths at runtime and in `bun test`.
- `client/metro.config.js`: `config.watchFolders = [path.resolve(__dirname, '../shared')]`.
  Nothing else. Expo's built-in tsconfig-paths support resolves `@shared/*`.
  `zod` imported by `shared/src/zod.ts` resolves upward from the importing
  file, so it lands on `shared/node_modules/zod`. A trial with
  `resolver.nodeModulesPaths` added made no difference, so it was removed: that
  way a shared file importing a client-only package fails to bundle.
- `client/eslint.config.js`: `eslint-config-expo` already resolves the
  tsconfig paths for `import/no-unresolved`.
- `api/package.json` and `client/package.json`:
  `"overrides": { "zod": "link:../shared/node_modules/zod" }`.
  `zod` is not a dependency of either package.
- Every `bunfig.toml`: `[install] registry = "https://registry.npmjs.org"`.

### Why the override

The plan expected api/ and client/ to have no zod at all. They do, through
transitive dependencies:

- `@modelcontextprotocol/sdk` has a hard `zod` dependency, and
- `eslint-plugin-react-hooks` (from `eslint-config-expo`) depends on zod.

Without the override, bun hoists a second physical zod into
`api/node_modules/zod`. The MCP test still passed that way, because the SDK
detects v4 schemas by their `_zod` property, not by instance. But a second zod
existed, and `import 'zod'` from api/ worked silently. With the override,
`api/node_modules/zod` (and `client/node_modules/zod`) is a symlink to
`shared/node_modules/zod`. Bun and Metro resolve the realpath, so there is one
zod module instance per runtime, the SDK's included. The iOS source map has
94 zod modules, all under `shared/node_modules/zod`.

Consequences:

- `shared/` must be installed before `api/` and `client/` (`task install` does
  shared first; the Dockerfile does too). If `shared/node_modules` is missing,
  the symlink dangles.
- After the override is added or changed, a plain `bun install` does not
  replace an existing real `node_modules/zod` directory. Delete `node_modules`
  and reinstall.
- The lint rule (`no-restricted-imports` on `zod` and `zod/*`) in
  `api/eslint.config.js` and `client/eslint.config.js` is what stops code from
  importing zod directly. Import it from `@shared/zod`.

## Checks and the commands that ran

All of these were run on 2026-11-17/18. Output is summarised.

| Check | Command (from the package dir) | Result |
|---|---|---|
| shared tests | `bun test` | 2 pass |
| shared types | `bunx tsc --noEmit` | clean |
| api tests | `bun test` | 8 pass (route, MCP, zod identity, Temporal bundle) |
| api types | `bunx tsc --noEmit` | clean |
| client tests | `bun test` | 3 pass |
| client types | `bunx tsc --noEmit` | clean |
| lint | `bunx eslint .` in api/ and client/ | clean; a probe file with `import { z } from 'zod'` fails with the rule message |
| web bundle | `bunx expo export --platform web --output-dir dist/web` | `Web Bundled ... (883 modules)`; `hello_get` found in `dist/web/_expo/static/js/web/index-*.js` |
| iOS bundle | `bunx expo export --platform ios --output-dir dist/ios --source-maps` | `iOS Bundled ... (1231 modules)`; source map lists `shared/src/{contracts/hello,operation-contract,zod}.ts`; `strings *.hbc` finds `hello_get` |
| iOS simulator | `bunx expo run:ios --configuration Release --no-bundler --device "iPhone 17 Pro"` (no one held the ios-simulator lease) | prebuild, pods and `› Build Succeeded`, `0 error(s)`; the embedded bundle was built from `shared/` (1231 modules). Installed on the simulator. The CLI then exited 1 with `Simulator app did not open fast enough`. `xcrun simctl launch` on the booted simulator, with the API on :3100, rendered `hello_get @ http://localhost:3100` / `Hello, Budget!` |
| MCP + zod | `api/src/mcp/tools.test.ts` | SDK registers, lists (JSON schema has `minLength: 1`) and calls the tool; empty name is rejected; `zod` resolved from api/ and from the SDK realpaths to `shared/node_modules/zod` |
| Temporal | `api/src/workflows/bundle.test.ts` | `bundleWorkflowCode` on `api/src/workflows/index.ts` succeeds |
| API image | `container build --dns 1.1.1.1 -f deploy/Dockerfile.api -t budget-api:phase0 .` (repo root) | built; `container run -p 127.0.0.1:3101:3100` answered `{"message":"Hello, Docker!"}` |
| End to end (web) | API on :3100 + `dist/web` served on :8092, loaded in a headless browser | page shows `hello_get @ http://localhost:3100` and `Hello, Budget!` |

Lockfiles: `grep -c fbr.land */bun.lock` gives 0 for all three.

## Surprises

- **Two transitive zods** (above). The override is the fix.
- **`docker build` failed, `container build` worked.** On this Mac `docker`
  is a shim (`mocker`) over Apple `container`. Its builder could not resolve
  DNS (`DNSResolveFailed downloading tarball zod@4.6.7`). `container build
  --dns 1.1.1.1` with the same Dockerfile and context built fine. CI on Linux
  runners should be fine with `docker build`.
- **Patch versions moved.** The ranges match syscd-app's `package.json`, but
  fresh installs resolved newer patch releases: expo 58.0.25 (syscd has
  58.0.14 installed), expo-router 58.0.31, MCP SDK 1.32.2, hono 4.13.18. React
  19.3.1, RN 0.88.1, reanimated 4.7.1, worklets 0.13.1, zod 4.6.7, Temporal
  1.25.0 and TypeScript 6.0.3 match exactly.
- **`expo run:ios` rejects `--port` with `--no-bundler`.** Use a Release build
  (embedded bundle, no Metro) to prove the native build without binding a
  port. Use `--port 8091` for dev builds, because 8081 belongs to syscd.
- The client was written by hand, not from `create-expo-app`. Without a
  `babel.config.js`, `babel-preset-expo` (which includes the worklets plugin
  in SDK 58) is used.
- `bun install` blocks two postinstalls in api/ (protobufjs). Nothing needed
  them for the bundle, the tests or the image.

## Phase 2: API lift-and-shift

Source: syscd-app server code, copied into `api/src/` (`core`, `user`, `oauth`,
`mcp`, `cli`, `jobs`, `budget`, `connections`, `rates` plus `index/worker/cli/mcp/app/catalog`).
Not carried: `health`, `ourtube`, `yt`, `ai` (wiring removed from `app.ts`,
`catalog.ts`, `index.ts`). The move is behaviour-identical except for the
items below.

### Migrations: copied unchanged, new ones start at 0100

The owner decided the new API connects to the SAME Postgres database syscd
uses in production, and syscd keeps running against it for a while. So there is
no squashed baseline (this reverses the plan's phase 2 step 2; G1-G3 are not
done here):

- `api/db/migrations/` holds all 33 syscd files, byte-identical, health and
  OurTube ones included, so `schema_migrations` stays consistent and a fresh
  local DB still builds. `MIGRATION_SIGNATURES` / `MIGRATION_EXEMPT` in
  `core/migrate.ts` are unchanged.
- **Numbering rule: a new migration is numbered `0100` or higher** so it cannot
  collide with numbers syscd may still add (0034+). It must be backward
  compatible with the running syscd code: additive only (new nullable columns,
  new tables, new indexes). No renames, drops or new NOT NULLs. It also needs
  a `MIGRATION_SIGNATURES` entry (`migrate.test.ts` enforces it).
- `accounts.currency` (G1) is deferred to a later phase.
- Migrator findings (read from `core/migrate.ts`, same file in syscd):
  - It selects `filename` from `schema_migrations` and only iterates the files
    present in its own `db/migrations` directory. Applied names it does not
    know are ignored: syscd tolerates our 0100+ rows and we tolerate syscd's
    0034+ rows. Tracked-but-unknown rows are never deleted.
  - `MIGRATION_SIGNATURES` is keyed by filename and only consulted per local
    file, so extra rows or extra files never break it. The heal step (tracked
    row whose signature probe fails is unmarked and re-run) applies to our files
    only.
  - Both runners take the same session advisory lock (`7_204_001`), so two
    processes booting at once serialize. Do not change that key in either app.
  - Gaps that remain from the plan (not fixed): a fresh DB cannot be migrated
    by the runner alone because 0010 is a data migration over seeded rows.
    Use `api/db/dev-initdb.sh` (compose) or the test preload's retry loop.
- Jobs relay scoping, verified in `jobs/store.ts`: `lockPending` selects
  `status = 'queued' and temporal_workflow_id is null and instance_id = $1`,
  and `enqueueJob` stamps `instance_id` from `JOBS_INSTANCE_ID`. So a worker
  only takes runs enqueued with its own instance id. Not scoped by instance:
  the dedup lookup (`findActive`: same job type + subject), the retention
  delete, the queued-count health figure and the admin list (unless filtered).
  Both apps must therefore run with different `JOBS_INSTANCE_ID`s; the default
  changed from `local` to `budget-local` so two unconfigured processes cannot
  share one by accident.

### Database naming

Everything this repo creates on the shared Postgres (localhost:5432) starts
with `budgetnew_`: dev `budgetnew_dev`, tests `budgetnew_test` (main checkout)
or `budgetnew_test_<sha1(repo root)[:8]>` (linked worktree). `BUDGET_TEST_DB`
may override the name but must match `budgetnew_test[a-z0-9_]*`; the preload
refuses to drop anything else. The owner's `budget` and syscd's `budget_test*`
databases are never touched. `docker-compose.yml` now creates `budgetnew_dev`
on its own Postgres (host 55432) and runs `api/db/dev-initdb.sh` on first start.
Seeds: only `db/seed/seed.sql` is carried (health CSVs and `seed_health.sql`
stayed in syscd; no carried test needs them).

### Auth config is injected (G11, minimal)

- `user/config.ts` holds an `AuthConfig` (cookie name/domain, app and API
  origin, native scheme allow-list, Google client, allow-list, session secret,
  service token, `authDisabled`). The entrypoint builds it from env in
  `src/auth-env.ts` and calls `configureAuth()`; `user/` no longer reads
  `process.env`. Pluggy's env is handed over the same way
  (`configurePluggyEnv(process.env)` in `index.ts` and `worker.ts`).
  `core/db.ts` still reads `DATABASE_URL`.
- The default config is fail-closed (no allow-list, no secret: every request
  is refused). `authDisabled` is never derived; it is true only when
  `AUTH_DISABLED_OK=1` and no Google/allow-list env is set.
- **Boot guard** (`checkAuthEnv`): the server exits unless the allow-list,
  Google client id and secret, and a `SESSION_SECRET` of at least 32 chars are
  all set. `AUTH_DISABLED_OK=1` is the only way to boot with auth off; it is
  refused when `KUBERNETES_SERVICE_HOST` is set and ignored (full rules apply)
  when any auth env is present. Empty strings count as unset. `task api` sets
  the opt-in for local dev.
- The worker, CLI and stdio MCP do not use the auth config.

### Rebrand and defaults

- CLI `budget`, credentials `$XDG_CONFIG_HOME/budget/credentials.json`, MCP
  server name `budget`, cookie `budget_session` (syscd's is `syscd_session`;
  both live under `.syscd.live`), native schemes `exp://` and `budgetapp://`,
  consent page title, `x-budget` key in `budget schema` output.
- Hosts: web `https://budget.syscd.live`, API `https://budget-api.syscd.live`,
  admin `https://budget-admin.syscd.live` (only used in tests; the admin origin
  comes from `ADMIN_ORIGIN`).
- API listens on `API_PORT` (default 3100; was `SERVER_PORT` 3000) and binds
  `API_HOST`. CLI and MCP use `BUDGET_API_URL` (fallback `API_URL`), default
  `http://localhost:3100`. CORS dev origins add `http://localhost:8091`.
- Temporal: `TEMPORAL_ADDRESS`, `TEMPORAL_NAMESPACE` (`budget` in production),
  `TEMPORAL_TASK_QUEUE` default `budget-jobs`. Empty values count as unset.
- Kept on purpose: the Pluggy `CLIENT_USER_ID` default `syscd-app` (existing
  Pluggy items are attached to it), the `OT_SERVICE_TOKEN` env name, the
  `@syscd.local` service/test e-mail addresses and the `syscd:users:bootstrap`
  advisory-lock hash (shared with syscd on purpose).
- `BUDGET_REPEAT_TICK=0|false|off|no` disables the in-process repeat-rule tick
  (default on), so only one of the two APIs on the shared DB generates
  occurrences.

### G13: client balance deltas removed

`deltas` is gone from `budget_transactions_create`, `_update` and `_delete`
(shared contracts) and from the handlers: balances are always derived on the
server. The input schemas are not strict, so a request that still carries
`deltas` is accepted and the key is ignored (stripped), not rejected. Tests:
`shared/src/contracts/budget/transactions.test.ts` and, against a real DB,
`api/src/budget/domain/transactions.test.ts` ("client-supplied deltas are
ignored"). Not a divergence from syscd: its no-deltas path (`server/budget/routes/transactions.ts:112,500-506,567`,
`deriveDeltas` at `domain/transactions.ts:132`, no date logic) already moves the cached
balance for a future-dated manual row. The old `fresh-start` test only skipped that
because it sent explicit `deltas: []`; its expectation changed accordingly and a
parity test pins the real behaviour. `balanceDeltaSchema` stays in `shared/src/validation.ts`, unused.

### Contracts and imports

Copied `*/contracts/`, `core/operation-contract.ts`, `budget/domain/schemas.ts`
and `connections/domain/schemas.ts` were deleted in favour of
`@shared/contracts/<feature>[/<file>]`, `@shared/operation-contract`,
`@shared/domain/{payees,transfers}`. The jobs and rates barrels in shared do not
re-export the named contracts, so api imports them by file
(`@shared/contracts/jobs/jobs`, `.../rates/rates`, `.../connections/connections`).
`core/validate.ts` keeps `HttpError`, `parseBody` etc. and re-exports the pure
validators from `@shared/validation`; `budget/domain/repeat-schedule.ts`
re-exports `FREQUENCIES` from shared. The phase 0 hello route and workflow are
gone; the zod-identity MCP test stays (`mcp/tools.test.ts`, with a local probe
contract) and the Temporal bundle test now bundles the real
`jobs/workflows/index.ts`.

### Tooling

- `api/tsconfig.json`: dropped `noUncheckedIndexedAccess` and added the `DOM`
  lib (syscd's expo base had neither strictness; the move stays a move).
- `api/eslint.config.js`: the server `import/no-restricted-paths` zones ported
  (core imports no feature; features import another feature through
  `index.ts` only), seams kept: connections -> `budget/domain`, jobs ->
  `connections/workflows.ts`, connections -> `jobs/workflows/tracked.ts`.
  The `modules/` seam is gone (that logic is `@shared/domain/*` now). The zod
  ban stays. `no-explicit-any`, unused-vars and prefer-const are off to match
  what `eslint-config-expo` enforced; tighten in phase 5.
- `shared/` gained `eslint.config.js` (zod ban except `src/zod.ts`, no node/hono/pg/react)
  and `eslint`/`typescript-eslint` devDependencies.
- Test env names: `BUDGET_REQUIRE_TEST_DB=1` (DB suites fail instead of skip),
  `BUDGET_TEST_DB`, `BUDGET_TEST_PG_BASE`, `BUDGET_TEST_DB_ISOLATED`.
  `task test:api` sets the first.
- `deploy/Dockerfile.api` also runs the worker: `bun src/worker.ts`. It copies
  `api/db/migrations` and `api/VERSION`. `api/VERSION` replaces syscd's root
  `VERSION` (read by `/health`).

### Env delta vs syscd (full list in `.env.schema`)

Added: `AUTH_DISABLED_OK`, `BUDGET_REPEAT_TICK`, `BUDGET_API_URL`, `API_PORT`,
`API_HOST`, `BUDGET_REQUIRE_TEST_DB`, `BUDGET_TEST_DB`, `BUDGET_TEST_PG_BASE`.
Renamed: `SERVER_PORT` -> `API_PORT`, `SERVER_HOST` -> `API_HOST`,
`SYSCD_API_URL` -> `BUDGET_API_URL`, `SYSCD_*TEST*` -> `BUDGET_*TEST*`.
Changed defaults: `TEMPORAL_TASK_QUEUE` `budget-jobs`, `JOBS_INSTANCE_ID`
`budget-local`, `APP_BASE_URL`/`API_BASE_URL` budget hosts, cookie name.
Dropped (features gone): all `OT_*` poll/retention vars, health, AI, yt vars.
`OT_SERVICE_TOKEN` is kept.

### Phase 2 checks

Run on 2026-11-18 from the `tk/budget-yue` worktree against Postgres :5432
(`budgetnew_*` only) and, for Temporal, a compose Temporal on :57233.

| Check | Result |
|---|---|
| `bunx tsc --noEmit` in shared, api | clean |
| `bunx eslint .` in shared, api | clean |
| `bun test` in shared | 34 pass |
| `BUDGET_REQUIRE_TEST_DB=1 bun test` in api | 649 pass, 0 fail, 48 files, 0 skipped |
| API boot on :3100, `budgetnew_dev`, `AUTH_DISABLED_OK=1` | `/health` 200, `GET /budgets` 200 (seed budgets), OAuth metadata 200 |
| Boot guard | no auth env: exit 1; `AUTH_DISABLED_OK=1` + `KUBERNETES_SERVICE_HOST`: exit 1 |
| `e2e-mcp http` and `stdio`, `e2e-consent`, CLI `login` + `whoami` | pass (auth on) |
| `e2e-jobs`, `e2e-connections` (fake adapter) | pass against compose Temporal :57233 |
| `container build --dns 1.1.1.1 -f deploy/Dockerfile.api -t budget-api:phase2 .` | built; image holds 33 migrations; boot guard fires without env |

## Phase 3: client lift-and-shift

Source: syscd-app at 8e79a31. Behaviour and visuals are meant to be
unchanged; this is a move, not a refactor.

### Layout

```
client/
  VERSION                 app release version (YYYY.MM.DD[-NN]), read by app.config.ts
  rn-web-events.d.ts      onContextMenu on ViewProps (desktop-web right-click menus)
  src/
    app/                  routes only
      _layout.tsx         composition root: gesture handler, safe area, DI, redux,
                          navigation theme, LoginGate; Stack of (budget), profile,
                          connected-apps
      (budget)/           _layout = BudgetLayout (rail / drawer / tabs) + one stub per
                          screen: index plan spending accounts reflect import backup
                          payees connect-bank connection linked-account
      profile.tsx  connected-apps.tsx
    store/                static configureStore (budgetApi, profileApi, budgetUi),
                          runtime (container + store), typed hooks over RootState
    budget/               modules/budget as is: domain data state model import
                          transfer ui screens (+ index.ts barrel)
    auth/                 LoginGate, useAuth, nativeAuth
    profile/              useMe, MeAvatarButton, ProfileScreen, ConnectedAppsScreen, ...
    shell/SettingsMenu    the pane-stack menu host (from AppsSwitcher)
    ui/                   theme, portal, combobox, avatar/, icon-symbol, media
    platform/             api/, di/, storage/, state/ (listeners, resetAppState),
                          import/pickImportFile, config, date
```

The budget screens sit in a `(budget)` route group so their URLs are at the
root (`/plan`, `/accounts`, ...) while `/profile` and `/connected-apps` stay
full-screen stack pages outside the rail, as in syscd.

Store and hooks live in `store/`, not `platform/`: the typed hooks need the
static `RootState`, which is built from the features' slices. Features import
only `store/hooks.ts` (RootState is a type-only import, no runtime cycle).
`resetAppState` moved to `platform/state/reset.ts` so `auth/` does not import
the store.

### Changed rather than copied

- Imports: `@core/*`, `@modules/*`, `@/components/*` and the relative
  `server/*/contracts` / `server/core/operation-contract` imports point at the
  new layout and at `@shared/contracts/{budget,connections,oauth}`,
  `@shared/operation-contract`, `@shared/zod`.
- `domain/payees.ts`, `domain/transfers.ts` and their tests are deleted;
  the 7 call sites import `@shared/domain/{payees,transfers}` directly (no
  shims).
- Routes: 25 `/budget/...` occurrences rewritten to root paths in 10 files:
  19 code literals (`router.push/replace/navigate`, `Href` constants, rail
  `NAV_LINKS`) and 6 comments. `app/budget/*` stubs became `app/(budget)/*`.
- Casts: 32 `as unknown as BudgetUiRootState` before, 31 removed (all were
  `useAppSelector((s) => select...(s as unknown as BudgetUiRootState))`), 1
  left: `state/planEdits.test.ts:292`, a test fixture object literal, not a
  store selector. The `(getState() as BudgetUiRootState)` thunk casts
  (non-`unknown`) are untouched.
- Tamagui removed: `screens/shell.tsx` uses `useMedia()` from `ui/media.ts`
  (`useWindowDimensions`). Breakpoints read from `@tamagui/config` 3.1.3
  `src/media.ts` (syscd's `tamagui.config.ts` uses `defaultConfig` from
  `@tamagui/config/v5`): `max-md` = width <= 768 - 0.02 on web (768 - 1 on
  native), `lg` = width >= 1024. Pure part in `ui/breakpoints.ts` with tests.
  No provider, no babel plugin.
- Settings menu: `core/apps/AppsSwitcher.tsx` became `shell/SettingsMenu.tsx`
  with the app list (and its registry lookup) removed. Kept: `MenuPane`,
  `useMenuNav` (`open`, `openBudget`, `editingBudgetId`, `back`, `close`),
  the `openRequest` mechanism behind `useBudgetShell().openPeople()`, the
  Modal portal, origin clamping, Escape-to-close, the trigger pill
  ("B / APP / Budget") and the ⚙ button. The trigger pill now opens the menu
  directly on the settings root (`panes[0]`); the root has no back button and
  its header shows `SETTINGS vX` (the version used to sit on the app-list
  header). Back from a pane opened by request (People) returns to the
  settings root instead of the app list. Accessibility label of the pill:
  "Open settings menu" (was "Switch app").
- `LoginGate`: `ThemedText` replaced by RN `Text` styled from the app theme
  (dark background `colors.bg`, `colors.text`; ThemedText's default and
  subtitle sizes kept). Title "Welcome to SysCD" became "Welcome to Budget";
  the dev hint names `task api`.
- `platform/config.ts`: with no `EXPO_PUBLIC_API_URL`, the API URL defaults
  to `http://localhost:3100` in dev (`__DEV__`) and
  `https://budget-api.syscd.live` in release builds. `app.config.ts` passes
  `extra.apiUrl` only when the env var is set; `connectionsProvider` stays
  env-driven (default `pluggy`). Native auth redirect: `Linking.createURL`
  with scheme `budgetapp`, so `budgetapp://login`.
- `platform/di/tokens.ts`: the `Logger` token is gone (nothing in budget,
  auth or profile resolved it).
- Store test rewritten for the static store (3 tests replace syscd's 4
  registry-based ones).
- `client/tsconfig.json` now matches syscd's compiler options:
  `moduleSuffixes: [".native", ""]` (needed for `ConnectBankWidget.native`,
  `listeners.native`) and `resolveJsonModule`; `noUncheckedIndexedAccess`
  (phase 0 default, never on in syscd) is off so the copied code typechecks
  unchanged.
- `metro.config.js` keys the cache on the resolved public app config (from
  syscd), minus `ios.buildNumber` / `android.versionCode`, which change on
  every evaluation.
- Versioning: `client/VERSION` (client-only; the API can version
  separately), validated and turned into `ios.version`, a UTC timestamp
  `ios.buildNumber` and an epoch-seconds `android.versionCode`, as in syscd.

### Dropped

Module contract and registry (`core/module/*`), `core/bootstrap.tsx`
(replaced by `store/runtime.ts` + `app/_layout.tsx`), the Apps switcher app
list and `AppSwitcherBar`, the `(tabs)` shell, `modules/mock`,
`core/logger`, `core/version` (+ its 11 tests), Tamagui (provider, babel
plugin, config), `themed-text`/`themed-view`, the phase 0 hello screen and
`src/data/hello*`.

### Dependencies

Added exactly what the copied code imports, at syscd's ranges: @expo/ui,
@expo/vector-icons, async-storage 3.1.1, @reduxjs/toolkit, react-redux,
expo-document-picker, expo-file-system, expo-font (required peer of
vector-icons/expo-symbols, flagged by expo-doctor), expo-image,
expo-image-manipulator, expo-image-picker, expo-sharing, expo-symbols,
expo-web-browser, fflate, pluggy-connect-sdk, gesture-handler, react-native-svg,
react-native-webview, xlsx (same CDN tarball). Dev: pluggy-js (type import),
sf-symbols-typescript (type import; transitive in syscd). Not added:
expo-haptics (nothing imports it), tamagui, hls.js, expo-camera.
`@react-navigation/native` is not needed: `ThemeProvider`/`DarkTheme` come
from `expo-router`. Config plugins: expo-router, expo-image, expo-sharing,
expo-status-bar, expo-web-browser (syscd's list minus expo-font and
expo-splash-screen, which budget does not configure).

### Lint

`client/eslint.config.js` (`import/no-restricted-paths`):
`app → store → {auth, profile, budget} → shell → ui → platform`; features
import each other only through `<feature>/index.ts`; features may import
only `store/hooks.ts` from `store/`; nothing imports `../api`;
`budget/domain` may not import react-native, expo, `@expo/*`, react or
react-dom, nor any other client directory; plus the existing zod ban. The
two experimental react-hooks v7 rules syscd turns off
(`set-state-in-effect`, `refs`) are off here too.

Phase 3 exceptions (per file, per target file; remove in phase 5a):

| File in `budget/domain/` | May import |
|---|---|
| `linkPicker.ts` | `data/connections`, `data/rows`, `data/mapping` |
| `linkPicker.test.ts` | `data/connections`, `data/rows` |
| `connectionSpark.ts`, `connectionSpark.test.ts` | `data/rows` |
| `syncRun.ts`, `syncRun.test.ts`, `bankPage.ts` | `data/connections` |
| `connections.ts` | `data/connections`, `ui/avatar/types` |
| `people.ts` | `ui/avatar/types` |
| `payments.test.ts` | `data/ledger` |
| `format.ts` | `platform/date` |
| `import.ts` (dead, test-only) | `budget/import/index` |

That is 17 violating imports in 13 files. No domain file imports
react-native. `bunx eslint .` leaves 10 warnings, all in copied code
(unused vars, `import/first` in `data/api.ts`, `array-type`, one unused
eslint-disable), none introduced by the move.

### Checks (2026-11-18)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` | clean |
| `bunx eslint .` | 0 errors, 10 warnings (above) |
| `bun test` | 666 pass, 0 fail, 47 files, no database |
| `bunx expo export --platform web` | `Web Bundled ... (1807 modules)` |
| `bunx expo export --platform ios` | `iOS Bundled ... (2310 modules)` |
| `bunx expo-doctor` | 19/20; version-mismatch check fails (below) |

Tests vs syscd's `bun test modules/budget core modules/auth modules/profile`
(counted by reading, not run): syscd has 49 files with 662 `it`/`test`
calls; the client has 47 files with 631. Difference: payees/transfers tests
(2 files, 21 tests) now run in `shared/`; `core/version.test.ts` (11) dropped
with `core/version`; the registry store test (4) replaced by the static store
test (3); `ui/breakpoints.test.ts` (2) added. 662 - 21 - 11 - 4 + 3 + 2 =
631. Bun reports 666 because of `.each` expansions.

expo-doctor reports SDK version drift for packages pinned to syscd's
versions (async-storage 3.1.1 vs 2.2.0 expected, gesture-handler 3.5.0 vs
~3.3.0, expo-web-browser 58.0.8 vs ~58.1.0, plus patch drift on expo,
expo-router, react, react-dom, @expo/ui, expo-file-system, react-native-svg,
worklets). Left as is: the phase copies syscd's versions.

### Smoke test

Level 2 (the walk against the real API) was not run. When this phase started,
`main` only had the phase 0 hello API; the phase 2 API landed on `main` while
it ran and was merged in at the end. Booting it needs `DATABASE_URL` for
`budgetnew_dev`: the shared Postgres on :5432 rejected `postgres` without a
password (`auth_failed`), no credentials were in the environment, syscd's
`.env` is off-limits, and `api/` was not to be touched (its `node_modules` on
`main` predates phase 2 and lacks `pg`). Reached level 1: the web export (API
URL `http://localhost:3100`, nothing listening) served on :8092 boots with no
page errors and shows "Can't reach the API" / `http://localhost:3100`
(`docs/evidence/phase3/level1-cannot-reach-api-1440.png`).

Beyond level 1, a second export pointed at a throwaway stub
(`docs/evidence/phase3/stub-api.ts`: `/auth/me` 200, one empty budget, empty
lists) rendered every route at 1440 wide (home, plan, accounts, spending,
reflect, payees, import, backup, connect-bank, profile, connected-apps) and
the plan at 900 (drawer) and 390 (tabs + FAB). The settings menu opened from
the pill on all three widths; "Add people" opened the People pane through
`openRequest`; Back returned to the settings root; Open Budget → Casa pushed
EDIT BUDGET via `openBudget`. No page errors except one caused by the stub
returning `[]` for `/connections/sync-status` (fixed in the stub, not the
app). Screenshots: `docs/evidence/phase3/stub-*.png`. This is not the
side-by-side parity pass against syscd with real data that the phase exit
asks for; that, and the iOS simulator pass, remain open.

## Phase 6: deploy

Deployed 2026-11-18 overnight (task budget-u1n). What needs the owner's
accounts is in `docs/MORNING.md`.

### What is where

| Piece | Where |
|---|---|
| Repo | https://github.com/yurifrl/budget (private). The name used to redirect to the renamed 2019 repo `budget-haskell`; that redirect is gone now. |
| Images | `ghcr.io/yurifrl/budget-{web,api,admin}`, release `2026.11.18` (amd64+arm64), built by `release.yml` run 44234399576, pinned in `k8s/values.yaml` by the bot commit `8bbcd88` |
| Cluster app | home-systems `k8s/applications/budget.yaml`: ONE Application, namespace `budget`, support chart + the app's own Temporal server (temporal chart 1.8.0, release `budget-temporal`, Temporal namespace `budget`, task queue `budget-jobs`) as a second source |
| Database | shared CNPG cluster `pg`, EXISTING database `budget` (syscd's live data), role `budget_app` with `inRoles: [syscd]`; Temporal on new databases `budget_temporal` + `budget_temporal_visibility`, role `budget_temporal` (home-systems `postgres.yaml`) |
| Secrets | 1Password vault `Kubernetes`, items `budget`, `budget-temporal`, `argocd-budget`, via External Secrets (same `onepassword` ClusterSecretStore as syscd); created by `scripts/create-1password-item.sh` |
| Hosts | `budget.syscd.live` (+ `budget.syscd.tech`), `budget-api.syscd.live` (Cloudflare Access bypass), `budget-admin.syscd.live` (Access Admin policy, + `.syscd.tech`), `budget-temporal.syscd.tech` (tailnet only) |

### Decisions taken during the deploy

- **Packages stay private.** syscd's `syscd-app*` packages are private too;
  the Talos nodes pull from ghcr.io with registry auth in their
  machineconfig. Making budget's public would expose the API image for no
  gain. GitHub has no REST endpoint to change package visibility anyway;
  MORNING.md has the clicks if pods ever show ImagePullBackOff.
- **No ArgoCD credential yet, so image tags are inline.** ArgoCD reads
  syscd-app through a per-repo deploy key (`argocd-syscd-app` in
  argo-support.yaml); there is no credential template covering
  `git@github.com:yurifrl/*`. `op` was not signed in, so the key could not be
  stored. budget.yaml declares the `argocd-budget` repository ExternalSecret
  itself (so its pending state shows only on this app), pins the four image
  tags inline, and leaves the `$values` source commented until the secret
  exists. The script creates the 1Password item and the read-only deploy key.
- **Role access via membership.** `budget_app` is a member of `syscd`
  (CNPG managed role `inRoles`, inherit by default), which gives it owner
  rights on syscd's objects in `budget` without any manual GRANT. Checked in
  CNPG v1.30.0 (the operator's version): a role whose password secret is
  missing is reported in `CannotReconcile` and does not block other roles
  (upstream fix #10053 is in v1.30.0).
- **Dual-run settings.** `BUDGET_REPEAT_TICK=0` (syscd still runs the tick),
  `JOBS_INSTANCE_ID=budget-prod` (syscd: `prod`), its own Temporal server.
  Both workers would run `connections-sweep` on the same connections once
  Pluggy credentials are filled; MORNING.md suggests leaving them empty until
  syscd's budget is turned off.
- **CI.** The first CI run (44234271033) failed only on `expo-doctor`, the
  SDK version-mismatch check recorded in phase 3. Making the step
  non-blocking was not done (left for the owner to decide), so `main` CI is
  red on that one step; every other job passed (shared, api incl. e2e,
  admin, three Docker builds).

## Phase 5b: API structure

Behaviour-preserving: the API runs against the same database as syscd, so no
migrations, no contract changes, same SQL effects and HTTP responses. Moved
SQL is byte-identical modulo indentation (checked by extracting every SQL
literal of the old route files and finding it in the new tree: 0 missing).

### withTransaction (G6)

`core/db.ts`: `withTransaction(pool, fn)` runs BEGIN, `fn(client)`, COMMIT;
on a throw it ROLLBACKs and rethrows the same error; the client is always
released (destroyed if ROLLBACK itself failed, and then the original error is
still the one thrown; the old blocks threw the ROLLBACK error in that
double-fault case). Nesting is rejected by the type: `db` must be a Pool, so
code inside a transaction passes its client to store functions instead.
28 blocks converted (budget routes 20, `budget/ownership` 1, oauth 2, user 4,
`core/migrate` 1). Post-commit work stays after the transaction, as before:
the account read-back in accounts create/update, and repeat-rule
materialization after rule create (it runs on its own connection and must see
the committed rule). Kept hand-rolled: `connections/sync.ts` (the race path
ROLLBACKs and returns null for a retry, and the `beforeCommit` cancellation
hook sits next to COMMIT on purpose) and `jobs/relay.ts` (rollback-and-return
of an error result, never a throw). Fresh-start's two early exits
(`not_found`, `already_archived`) used to send an explicit ROLLBACK; they now
return before any write and let withTransaction COMMIT a transaction that
only holds the row lock (same effect).

### Store layer (G6)

`budget/store/<area>.ts`: accounts, budgets, bundles, categories, members,
payees, repeat-rules, transactions. Functions take a `Queryable` and typed
params and return rows. Routes parse, authorise, call store/domain, shape
the response. Moved out of route files: `generateDueOccurrences` /
`generateAllBudgets` to `budget/domain/repeat-generation.ts` (the barrel's
tick imports it from there), `goalColumns` to `budget/domain/category-goals.ts`.
The PATCH /transactions set-clause builder became `updateTransactionSet`
(ordered entries; renders the same statement, unit-tested).

`(client|pool|db|pg).query` calls in `budget/routes/*.ts` (non-test): 252 in
18 files before, 31 in 8 files after. Still holding SQL: `budget-restore.ts`
(11), `groups.ts` (5), `category-targets.ts` (4), `assignments.ts` (3),
`category-notes.ts` (3), `month-notes.ts` (2), `plan-auto-assign.ts` (2),
`budget-export.ts` (1). Those areas have little direct test coverage;
characterisation tests come first when they move.

### Ledger API (G5)

`budget/ledger.ts`, exported from the budget barrel as `ledger`, is the only
way connections writes budget's tables: `createImportPayeeResolver`,
`insertImportedTransaction`, `refreshImportedTransaction`,
`tombstoneTransaction`, `applyBalanceDeltas`, `linkCardPayments`. Payee
resolution is built on budget's own `loadRenameRules` + `applyRules` +
`upsertPayee`. Line-by-line diff of sync's deleted `PayeeResolver` against
budget's helpers:

- rename-rule query: identical text (whitespace only);
- payee upsert statement: identical;
- **name trimming differs**: budget's `upsertPayee` trims the effective name
  before storing it; sync stored it verbatim once non-blank (an `is` rule's
  replacement is a payee name used as-is, e.g. `" Padded "`). Kept via
  `upsertPayee(..., { verbatim: true })`, pinned by
  `connections/sync-payees.test.ts`;
- sync loads the rules once per resolver (lazily, on the first non-blank
  name) and caches per raw name; kept in the resolver. Budget's
  `resolvePayeeId` still loads per call;
- sync stores the rule-rewritten name in `import_payee_name(_original)` and
  the shadow payload; `/bulk` stores the raw statement text. Different on
  purpose, both kept;
- the import row: sync inserts cleared-as-reported, unapproved, no
  memo/category, no ON CONFLICT (it looked the import id up first); `/bulk`
  inserts uncleared with ON CONFLICT DO NOTHING. Two store functions, each
  with its original SQL.

Connections exposes `connections/ledger-reads.ts` (barrel):
`findUserConnection` (account linking), `blockedImportShadowIds` and
`blockImportShadows` (card-payment pairing). `card-payments.ts` no longer
joins `connection_transactions`: the candidate query computes the untouched
flag without the shadow and the blocked set is applied in JS
(`connection_transactions.transaction_id` is the primary key, so the join
never duplicated rows; same result). Still in budget SQL: the accounts list's
display LEFT JOIN on `connections`/`users` for `linked_by`, and the copy of
`accounts.connection_id` in fresh start (budget's own column). Still in
connections SQL: the reads that join `transactions` with the shadow table
(existing-row lookup, tombstone sweep, linked accounts). The ESLint
`connections -> budget/domain` exception is gone. The two barrels import each
other; neither uses the other's exports at module evaluation, so the cycle is
inert.

### Access checks (G14)

No runtime change. `src/access.test.ts` takes every budget/connections
operation with a path param from the contract catalog (38) and runs it as a
non-member: (A) the 11 without `budget_id` (budgets/:id, connections/:id)
answer 404; (B) the 27 with `budget_id`, sent with the attacker's own budget
id and the victim's row id, answer 404, leave the victim budget unchanged
(row-level JSON snapshot), leak nothing, and create no cross-budget pointer.
All pass: no hole found. A new path-param operation fails the coverage test
until it has a sample. Body-carried ids (e.g. `categories reorder`
`group_id`) are not covered yet (follow-up).

### Core hygiene (G16, G11)

- `core/db.ts` reads no env. The pool is an unconfigured `AppPool` (a real
  pg Pool whose `connect()` rejects until `configureDb({ connectionString })`).
  `index.ts` and `worker.ts` call it first with `DATABASE_URL` (same boot
  error message when it is missing), so do `scripts/e2e-jobs.ts` and
  `e2e-connections.ts`. The bun test preload configures the throwaway test
  database (or the dev one on fallback); with nothing configured, DB suites
  skip (or fail under `BUDGET_REQUIRE_TEST_DB=1`). A Proxy wrapper was tried
  first and dropped: `spyOn(pool, 'query')` does not land on a Proxy.
- `core/validate.ts` no longer re-exports the budget value schemas (cents,
  cleared, flag, dates); only the id validators. `core/csv.ts` (syscd's
  health CSV parser, no importer) deleted.
- `process.env` in `src/<feature>/` and `src/core/`: only `core/test-gate.ts`
  (test-only gate, reads the preload's markers).

### Repeat-rule tick (G15): not moved

Moving it needs a budget workflow in the Temporal bundle (a new jobs seam),
an activity over `generateAllBudgets`, interval support and schedule removal
in `ensureSchedule` (cron only today), and the env switch moving from the API
to the worker; none of that schedule code has unit tests (only the
Temporal-backed e2e). Left as the in-process tick (`BUDGET_REPEAT_TICK=0` in
production); follow-up filed.

