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

The API on `main` is still the phase 0 hello app, so the full walk against a
real API (level 2) was not possible. Reached level 1: the web export (API
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
||||||| f437230
