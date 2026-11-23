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
  (Extended for Cloudflare Access: see "Access sign-in" below.)
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
  VERSION                 iOS app release version (YYYY.MM.DD[-NN]), read by app.config.ts
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
- **ArgoCD reads image tags from this repo.** ArgoCD reads
  syscd-app through a per-repo deploy key (`argocd-syscd-app` in
  argo-support.yaml); there is no working credential template for
  `git@github.com:yurifrl/*`. budget.yaml declares the `argocd-budget`
  repository ExternalSecret itself (so its pending state shows only on this
  app). The `$values` source was first left commented until the read-only
  deploy key was on yurifrl/budget; since 2026-11-21 it is enabled and
  `k8s/values.yaml` `imageTags` overrides the inline fallback tags, so a
  release deploys with no home-systems commit.
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

### expo-doctor: aligned versions and declared pins (2026-11-18, wrap-up)

CI's `client` job ran `bunx expo-doctor`, which failed on 11 packages that
differ from the versions Expo's SDK-58 list expects. Each was resolved one
way or the other; the step stays blocking.

Aligned to the SDK-expected version (`bunx expo install`; these are
downgrades from syscd's versions): `react` / `react-dom` 19.3.1 -> 19.3.0,
`react-native-gesture-handler` 3.5.0 -> ~3.3.0, `react-native-svg` 15.16.1
-> 15.16.0, `react-native-worklets` 0.13.1 -> 0.13.0. After the change:
client tsc clean, eslint clean, `bun test` 1054 pass, web export (1946
modules) and iOS export (2451 modules) bundle, and a web smoke against a local
API on `budgetnew_dev` behaved like the build from `main` side by side: rail
navigation and browser Back (same history lengths and Back targets in both),
a category drag reorder (persisted, then put back), and a number-format
change that survived a reload (then put back). iOS was not run.

Declared as intentional pins in `client/package.json` `expo.install.exclude`
(the mechanism Expo documents for this; expo-doctor and `expo install
--check` skip them):

- `expo-router` (58.0.23, expected ~58.0.32): the browser-Back fix, see
  `docs/evidence/parity/REPORT.md` regression 1. Later patches replace the
  history entry on tab navigation.
- `@react-native-async-storage/async-storage` (3.1.1, expected 2.2.0):
  syscd ships 3.1.1; going to 2.x is a major downgrade of the storage layer
  (where the native session token migrates from), not worth the risk for a
  version check.
- `expo` (58.0.25 -> ~58.0.26), `@expo/ui` (58.0.28 -> ~58.0.29),
  `expo-file-system` (58.0.13 -> ~58.0.14), `expo-web-browser` (58.0.8 ->
  ~58.1.0): the expected versions were published on 2026-11-17 around
  12:00 UTC. This machine's package installer refuses packages younger than
  48 hours (supply-chain policy, not bypassed), so they cannot be installed
  before 2026-11-19 12:00 UTC. Temporary: after that date remove these four
  from the exclude list and run `bunx expo install expo @expo/ui
  expo-file-system expo-web-browser` (follow-up `budget-ef9`).

Note that the expected versions come from Expo's servers and move whenever
Expo publishes an SDK-58 patch, so this check can turn red again without a
commit here; the fix is the same choice (align, or declare the pin).

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


### Phase 5b follow-up

- **Store layer finished.** `budget-restore`, `groups`, `category-targets`,
  `assignments`, `category-notes`, `month-notes`, `plan-auto-assign` and
  `budget-export` call `budget/store/{restore,groups,category-targets,
  assignments,notes,export}.ts` (plus `liveCategoryInBudget` in
  `store/categories.ts`). No file under `budget/routes/` holds SQL any more;
  `budget/routes-no-sql.test.ts` fails on a `.query(` call or an SQL statement
  in a string literal there. The 42 SQL literals of the eight old files were
  extracted and each found unchanged (whitespace-normalised) in the new tree.
  `routes/small-areas.test.ts` pins the previously untested areas.
- **Access test covers body/query ids.** `access.test.ts` section C derives
  every uuid-typed input field that is not a path param or `budget_id` from the
  contract schemas (`z.toJSONSchema` + the uuid pattern) and fails until each
  has an attack case (member of A supplies B's id) or an allow-list reason (none
  today). It asserts the status, that B and A are unchanged, that no
  response leaks B names, and that no A row points at a B row (19 pointer
  columns plus person ids). It found four holes, all also in syscd-app and
  fixed with the neighbours' predicate: `assignments` set/batch accepted a
  foreign `category_id` (now 400 `category not found in budget`, like
  plan-auto-assign); `categories reorder` accepted a foreign `moves[].group_id`
  (404 like create); `transactions` PATCH accepted a foreign `patch.category_id`
  (400 like create) and a foreign `patch.matched_transaction_id` (400). The
  checks are any-state (tombstoned rows of the same budget still pass), so
  legitimate requests are unchanged.

## Phase 5d: money units (G7)

### The rule

Every amount on the wire, in both directions, for every operation, is an
integer number of **milliunits** (1/1000 of the currency unit: 12.34 = 12340,
-5 = -5000). **Amount fields carry no unit suffix** (`amount`, `inflow`,
`outflow`, `balance`, `budgeted`, `limit`, ...); a `*_cents` / `*Cents` field
no longer exists anywhere on the wire. The rule is `MONEY_UNIT_RULE` /
`milliunitsSchema` in `shared/src/validation.ts`, repeated in every money
operation's description (that is what `budget schema`, `--help` and the MCP
tool list show).

Storage did not change (it was already milliunits, except
`category_targets.amount_cents`, see below). The x10 / /10 that used to sit
in handlers are gone; the remaining conversions are exactly:

| Where | Conversion | Why |
|---|---|---|
| `connections/adapters/pluggy` `milliFrom` | `Math.round(amount * 100) * 10` | Pluggy floats -> port milliunits, once, at the adapter. Rounded to whole cents first so rows stored by earlier syncs (which stored `round(x*100)*10`) compare equal and are not "refreshed". |
| `budget/routes/category-targets.ts` | wire `amount` / 10 -> `amount_cents`; x10 on read | That table stores cents. The contract only accepts multiples of 10, so nothing is rounded. |
| `budget/routes/budget-export.ts` `category_targets[].amount` | `amount_cents * 10` | same table |
| `upgradeRestorePayload` (shared) | x10 on a format-1 backup | legacy backups (below) |
| client `data/` (`mapping.ts`, `api.ts`, `connections.ts`) | cents <-> milliunits | the app's domain keeps cents in memory |

`BalanceDelta` (internal, `budget/domain/transactions.ts`) is milliunits too,
so `deriveDeltas`, `applyBalanceDeltas`, repeat generation and the sync
engine add stored amounts directly.

### Inventory

"In" = request input, "out" = response. Unit before -> after.

| Operation | Field | Dir | Before | After |
|---|---|---|---|---|
| `budget_transactions_create` | `txn.inflow_cents`, `txn.outflow_cents` | in | cents | `txn.inflow`, `txn.outflow` milliunits |
| `budget_transactions_create` | `subtransactions[].inflow_cents/outflow_cents` | in | cents | `subtransactions[].inflow/outflow` milliunits |
| `budget_transactions_update` | `patch.inflow_cents/outflow_cents` | in | cents | `patch.inflow/outflow` milliunits |
| `budget_transactions_update` | `subtransactions[].inflow_cents/outflow_cents` | in | cents | `inflow/outflow` milliunits |
| `budget_transactions_bulk_import` | `txns[].inflow_cents/outflow_cents` | in | cents | `txns[].inflow/outflow` milliunits |
| `budget_transaction_add` | `amount_cents` (signed) | in | cents | `amount` milliunits |
| `budget_accounts_create` | `balance_cents` | in | cents | `balance` milliunits |
| `budget_accounts_update` | `working_balance_cents` | in | cents | `working_balance` milliunits |
| `budget_accounts_reconcile` | `stated_balance_cents` | in | cents | `stated_balance` milliunits |
| `budget_repeat_rules_create` | `inflow_cents`, `outflow_cents` | in | cents | `inflow`, `outflow` milliunits |
| `budget_category_targets_set` | `amount_cents` | in | cents | `amount` milliunits, multiple of 10 |
| `budget_category_targets_set` / `_list` | `amount_cents` | out | cents | `amount` milliunits |
| `budget_categories_set_target` | `target.amount_cents` | in | cents | `target.amount` milliunits |
| `budget_plan_auto_assign` | `rows[].assign_cents` | in | cents | `rows[].assigned` milliunits |
| `budget_restore` | `transactions[].outflow/inflow`, `assignments[].budgeted` | in | cents | milliunits when `format_version: 2`; absent/1 = legacy cents, upgraded |
| `budget_export` | `transactions[].outflow/inflow`, `assignments[].budgeted` | out | cents | milliunits, plus `format_version: 2` |
| `budget_export` | `category_targets[].amount_cents`, `repeat_rules[].amount_cents`, `splits[].amount_cents` | out | cents | `amount` milliunits |
| `connections_upstream_list`, `connections_items_register` | `accounts[].balanceCents` | out | cents | `balance` milliunits |
| same | `credit.{limitCents, availableCents, usedCents, minimumPaymentCents}` | out | cents | `credit.{limit, available, used, minimumPayment}` milliunits |
| same | `credit.latestBill.{totalCents, minimumPaymentCents}` | out | cents | `latestBill.{total, minimumPayment}` milliunits |

Already milliunits and unchanged: `budget_assignments_set` / `_batch`
`budgeted` (in), and every read amount: transactions and split `amount`,
account `cleared_balance` / `uncleared_balance`, assignment `budgeted`,
category `goal_target`, repeat-rule `amount`, payee-ledger `amount`,
connection summary `balance`, connection transactions `amount`. That is
**36 fields converted** (each field of each row counted once; the shared upstream account shape counted once) across
16 operations; rates (`rate` is a ratio) and jobs carry no money.

### Validation of sub-cent values

Any integer milliunit is accepted. The database already holds YNAB-imported
values, and storing a value is lossless; the app's own writes are always
multiples of 10 (its domain is cents), and it displays `Math.round(m / 10)`
cents as before. The dev database has 0 sub-cent rows (checked:
transactions, subtransactions, assignments, balances, goals), production was
not inspected. The one exception is `budget_category_targets_set.amount`,
which must be a multiple of 10 (400 otherwise) because `category_targets`
stores whole cents and silent rounding would make write != read. Behaviour
change, on purpose: a sub-cent row now exports and re-imports exactly (the old
cents export emitted fractional cents, which its own restore rejected).

### Backups

- `budget_export` writes `format_version: 2` (milliunits). `budget_restore`
  accepts `format_version` 2, or 1 / absent = the original syscd format in
  cents, which `upgradeRestorePayload` (shared) scales x10 before anything is
  written. Any other value is a 400. So every old backup file still restores
  through the API, the CLI and MCP-less clients alike.
- `api/src/budget/routes/fixtures/syscd-backup-v1.json` was produced by the
  ORIGINAL export code (this repo at `08ff6fd`, the same code as syscd's) from
  the seeded Trabalho budget; `budget-restore-legacy.test.ts` restores it,
  checks every stored amount is cents x 10, that v1, unversioned and the
  equivalent v2 document land identical rows, and that the re-export is the
  same document in milliunits.
- The app's backup files are the Plan/Register TSV archive
  (`client/src/budget/transfer`), decimal strings with no unit, parsed into
  the cents domain. That path is unchanged; `data/` converts the resulting
  payload to a format-2 document before it is sent.

## G1: `accounts.currency` (migration 0100)

`api/db/migrations/0100_account_currency.sql`: `alter table public.accounts
add column if not exists currency text constraint accounts_currency_iso4217
check (currency ~ '^[A-Z]{3}$')`. Nullable, no default, no backfill: NULL
means "the budget's currency" (`budgets.currency_format`), which every
existing row is. Signature `column:public.accounts.currency`. Adding a
nullable column with no default is a catalog-only change in Postgres; the
CHECK is validated against existing rows, all NULL, under a short lock on a
small table.

API: `currency` (ISO 4217, trimmed and upper-cased by `currencyCodeSchema`,
null clears) on `budget_accounts_create` / `_update`; returned by every
account read (`SELECT a.*`); carried by fresh start, by `budget_export`
(`accounts[].currency`) and `budget_restore` (optional, older backups have no
key). A closed account rejects a currency change like any other field. No
amount is converted anywhere.

Bank sync: when some linked account of a connection has no currency, the sync
lists the item's upstream accounts once (same timeout as the pulls, failures
swallowed) and, inside its write transaction, runs
`UPDATE accounts SET currency = $code WHERE id = $id AND currency IS NULL`
through `ledger.adoptAccountCurrency`. A user-set value is never overwritten,
an invalid provider code is ignored, and once every linked account has a
currency no extra provider call is made. Linking alone does not set it (the
link request has no provider data server-side); the next sync of the
connection does. Tests: `connections/sync-currency.test.ts`,
`budget/routes/accounts-currency.test.ts`.

Client: `AccountRow` carries `currency` (wire type), but the domain `Account`
(`client/src/budget/domain/types.ts`) is outside `data/`, so the app ignores
it for now (follow-up filed for the UI).

### Why the running syscd-app keeps working with the extra column

Checked by grepping syscd-app at 8e79a31 (`server/`, `modules/`, `scripts/`)
for every statement touching `accounts`:

- **`SELECT *` / `a.*` row mapping** (`server/budget/routes/accounts.ts:118,249`
  read-back, `:429` list): the rows are returned as JSON. The extra
  `currency` key reaches syscd's client, whose `AccountRow` mapping
  (`modules/budget/data/mapping.ts`) reads named fields only and ignores
  unknown keys. No code spreads such a row back into an INSERT/UPDATE.
- **Every `INSERT INTO accounts` names its columns**: account create
  (`accounts.ts:86`), restore (`budget-restore.ts:139`) and fresh start
  (`budgets.ts:164-175`). An unnamed nullable column with no default simply
  gets NULL, so all three keep succeeding. Consequence: a fresh start or a
  restore run *from syscd's UI* produces accounts with currency NULL (the
  budget's currency), i.e. a user-set currency is not carried by syscd's
  copy paths. Nothing in syscd can set a currency, so this can only lose a
  value set through this API during the dual-run; accepted.
- **Every other read names its columns** (`connections/routes.ts:202,288,344,392`,
  `connections/store.ts:174`, `connections/sync.ts:270`, budget domain
  `transactions.ts:78`, `transfers.ts`, `card-payments.ts:119`,
  `budget-export.ts:60`, `repeat-rules.ts:171`): unaffected.
- **Export** names `id, name, user_id`, so syscd backups simply lack
  `currency` and restore here as NULL.
- No `TRUNCATE`, `COPY` or dump/restore of `accounts` exists in syscd.
- Migrations: syscd's runner only iterates its own files and ignores the
  unknown `0100_account_currency.sql` row in `schema_migrations` (phase 2
  findings), and the column name cannot collide with a future syscd
  migration number (0034+).

## Phase 5c: contract outputs (G9)

- `defineOperation` takes an optional `output` zod schema (the 2xx JSON body
  after serialization; `z.null()` for a 204). **89 of the 96 catalog
  operations have one: all 70 budget, all 14 connections, rates (1) and user
  (4)**; jobs (5) and oauth (2) do not yet (admin / consent surfaces, outside
  this phase; follow-up filed). Row schemas live in
  `shared/src/contracts/{budget,connections}/outputs.ts`, transcribed from the
  client's hand-written `rows.ts` / `connections.ts` and corrected where the
  transcription met reality: `connections.client_user_id` and `.environment`
  are nullable text (the client claimed a non-null enum); the USD/BRL rate
  answers `{ rate, source, stale, fetched_at }` (the client's type claimed
  `as_of`, which never existed); `connect-token`'s `clientId` is nullable.
  Objects are non-strict (most reads are `SELECT *`), so a declared field that
  is missing or mistyped fails, extra columns do not.
- **Server checking.** `mountOperations` parses each handler result (JSON
  round-tripped, or a returned JSON Response's body) with `output` when output
  validation is on: `throw` under `bun test` (set by the preload, so a drift
  is a 500 in whichever test exercised the handler: every one of the 800+ API
  tests now doubles as an output check), `warn`/`throw` in local dev via
  `API_VALIDATE_OUTPUT`, never in a cluster (`KUBERNETES_SERVICE_HOST` wins)
  and off by default. `api/src/catalog-outputs.test.ts` seeds a budget (groups,
  bundle, split, transfer, targets, notes, rule, placeholder member) and a
  synced bank connection with a fake aggregator, then calls all 24 budget and
  connections reads over HTTP and parses each answer; every list must come
  back non-empty so its row schema met real rows. It also fails when a
  budget/connections operation has no output or a read has no sample.
- **MCP.** Tools whose `output` is a zod object advertise it as
  `outputSchema` and return it as `structuredContent` (29 of the 66 MCP
  tools; lists and 204s cannot, MCP requires an object schema). The SDK checks
  the structured result against it, and so do MCP clients: a zod object
  exports `additionalProperties: false`, and rows carry more columns than
  declared, so `scripts/e2e-api.sh` failed until `mcpOutputSchema` started
  advertising a copy with every object loosened (`z.looseObject`). The
  contract schemas themselves stay plain objects, so the client's inferred
  types have no index signature.
- **Client types.** `data/rows.ts` and `data/connections.ts` are now
  `z.infer` aliases under the old names (hand-written duplicates deleted;
  `ScheduledTransactionRow`, `PayeeLocationRow`, `ScheduledFrequency` were
  unused and had no endpoint, so they went). The upstream-account `*Json`
  types stay cents views of the wire types (`Omit<Wire, ...> & {...Cents}`),
  because the domain and screens read cents. `accounts.currency` is optional
  in the schema so pre-G1 fixtures outside `data/` stay valid.
- **URLs.** The 13 hand-written URLs in `data/api.ts` are gone: 11
  connections routes and `/rates/usd-brl` had contracts; two new contracts
  describe existing routes unchanged: `connections_connect_token` (POST
  `/connections/connect-token`, api-only; the handler became an operation)
  and `user_auth_me` (GET `/auth/me`, api-only; mounted as an operation ahead
  of the auth middleware, still answering 401 itself). `profile/api.ts` also
  moved `/me` GET/PATCH and `/me/avatar` DELETE to their existing contracts
  (the binary PUT `/me/avatar` stays hand-written).
- **Slice split.** `data/api.ts` (1,228 lines) became a 116-line re-export of
  one api assembled from `data/api/base.ts` (createApi: same reducer path,
  base query, tag types, refetch policy) plus `budgets`, `members`, `plan`,
  `payees`, `register`, `connections` injected in that order (each endpoint
  block moved verbatim, 82 endpoints), and `data/api/types.ts`. No import
  outside `data/` changed; hook names, tags, `keepUnusedDataFor` and
  optimistic updates are identical. A test pins 82 endpoints on the one api.
- **`contractRequest`** moved to `shared/src/contract-request.ts`; the client
  copy (`platform/api/contractRequest.ts`) and the admin copy are deleted. The
  client's `ApiQuery` is now an alias of shared `ContractRequest`.
- **Errors (G12-low).** `{ error, code }`, see `shared/README.md`. The client's
  `ApiQueryError` carries `code`; `apiErrorMessage` is unchanged.

### Phase 5c/5d checks (2026-11-18, branch `tk/budget-ku4`)

| Check | Result |
|---|---|
| `bunx tsc --noEmit` shared / api / client / admin | clean |
| `bunx eslint .` shared / api / client | 0 errors; client 8 warnings (was 10; none new) |
| `bun test` shared | 43 pass (was 34) |
| `BUDGET_REQUIRE_TEST_DB=1 bun test` api | 838 pass, 0 fail (was 785), with output validation on |
| `bun test` client | 679 pass (was 666; 5 contractRequest tests moved to shared) |
| admin `vite build` | built |
| `scripts/e2e-api.sh` (psql shimmed with `pg`; no psql on this host) | exit 0: OAuth consent, 66 MCP tools rw / 24 ro, `budget_transaction_add` with `amount` in milliunits |
| `expo export --platform web` | 1812 modules |
| Real stack: API on :3197 against `budgetnew_dev` (migrator applied `0100_account_currency.sql`), web export on :8197; the pre-change build (08ff6fd) on :3198/:8198 against the same database | see below |

End to end with `agent-browser` at 1440x900 on the Trabalho budget, all
through the new UI, verified through the API:

- add a transaction of 12,34 on Carteira: stored `12340`;
- edit it to 56,78: stored `56780`;
- assign 100,00 to Psiquiatra: assignment `100000`;
- move 25,50 from Mercado to Transporte: `750000 -> 724500` and
  `300000 -> 325500` (exactly 25500);
- transfer 10,00 Carteira -> Itau Cartão: legs `-10000` / `+10000`, linked
  both ways. (A first try to Poupança Nubank answered 400 "transfer account
  not found in budget" on the old and the new API alike: Trabalho's transfer
  payees for two accounts point at Casa's accounts, a pre-existing restore
  bug, follow-up `budget-njc`.)
- Plan and Accounts rendered by the new and the old build, same data, before
  and after the writes: the page text is identical (151 amount strings on
  Plan, 95/98 on Accounts) and the 1440 screenshots are pixel-identical (0
  differing pixels). The parity screenshots in `docs/evidence/parity/1440`
  show other data (the parity walk changed it), so the old build on the same
  database is the baseline. The API ran with `API_VALIDATE_OUTPUT=warn`: 0
  output-schema warnings over the whole session.
- The test writes were reverted afterwards (rows deleted, assignments reset).

Screenshots: `docs/evidence/phase5d/`. Follow-ups: `budget-njc` (restore
transfer-payee scope), `budget-fys` (currency UI), `budget-vyz` (jobs/oauth
outputs), `budget-ows` (currency at link time).

### Assertions converted

Unit changes converted 22 expected values in existing assertions (api 15:
domain deltas 1, export 5, category targets 2, Pluggy adapter 7; client 7:
request bodies 2, mapping 4, contractRequest 1) plus 1 rename-only
(`usedCents` -> `used`, null); every input literal in tests was scaled x10
explicitly. The error-code change added `code` to 15 exact error-body
assertions and 1 key-list assertion. Two assertions encoded the old design
and were replaced by stronger ones: "connect-token is not an operation" (now:
it is an api-only operation) and the restore request body (now: format 2 with
amounts x10).

## Phase 5a/5e: client domain purity and structure

Branch `tk/budget-sfa` (tasks budget-sfa, budget-dqt). Behaviour-preserving
except the intended fixes listed at the end. Split work (PlanScreen;
AccountsScreen + register; ui/bits + MenuPanes; the other large screens) ran
in four parallel sub-branches merged into the task branch before the moves.

### Domain purity (5a)

- `domain/` imports only itself and `@shared/*`; ESLint has no exceptions
  (17 violating imports in 13 files before, 0 after) and
  `src/architecture.test.ts` checks it independently.
- Wire-typed helpers left the domain: `linkPicker`, `connectionSpark`,
  `syncRun`, `bankPage`, `connections` are `features/banks/model/*` (they take
  wire rows; only the bank screens and the account editor use them).
  `bankPage.milliToCents` (a copy of `data/mapping`'s) was dropped. Avatar
  types' one definition is `domain/avatar.ts`; `platform/date` became
  `domain/date` (pure).
- Singletons removed: `fmtPrefs`, `moneyMask`, `flagLabels` module state and
  the `ui/stores` bridge. Formatters are pure (`formatMoneyWith(prefs, cents,
  masked)` etc.; `moneyFormat(prefs, masked)` binds them). Prefs, flag labels
  and the Hide Amounts mask live in the budgetUi slice; `state/budgetSettings`
  is the one listener that loads the per-budget blob on every
  `setActiveBudget` (stale loads dropped) and persists settings actions (same
  sectioned patches the panes wrote; the Plan toolbar's toggles and the mask
  stay unpersisted, as before). Components read `useMoneyFormat()`
  (`ui/moneyFormat.tsx`, a context fed from the slice at the root), so a
  change re-renders every formatter: this fixes budget-xef
  (`docs/evidence/phase5e/xef-*.png`). Non-React callers (plan-edit labels,
  overspend hints, quick math) take the formatter as a parameter defaulting
  to pt-BR. Editing a non-active budget's format still writes only its blob.
  `setFmtPrefs`/`setFlagLabels` remain as no-op exports only for
  `data/settingsBlob.applyBudgetSettings` (data/ was not edited; budget-5rk).
- Cycles: `madge --circular` found 3 (state/ui <-> planEdits, shell <->
  MenuPanes, CategoryDropdown -> PayeeDropdown -> ManagePayeesModal ->
  ManagePayeesScreen -> CategoryDropdown); all broken (`state/keys.ts`, shell
  context in its own module, `transferPayeeName` from `@shared`). Guard:
  `architecture.test.ts` (Tarjan over runtime imports under `src/`), 0 cycles.
- Two engines: `domain/zeroSum.ts` (`computeBudgetMonth`) is canonical, per
  `docs/budget-engine-spec.md` (copied from syscd with
  `category-bundles-design.md`). `engine.ts` is not a second engine: it holds
  helpers around it (balances, assigned lookups, target funding, Cost to Be
  Me, group rollups over zeroSum figures, and the legacy `recomputeActivity`
  data/mapping still calls). Nothing was provably dead, so nothing was
  removed; the header now says so.
- Dead/stray: `domain/import.ts` deleted; `seed.ts` and `zeroSum.fixtures.ts`
  in `domain/__fixtures__/`; the payment move-money tests that used
  `data/ledger` moved to `state/paymentMoves.test.ts`.

### One definition per helper (G19)

`monthOfDate` (engine, zeroSum, transfer), `monthKeyFromDate`/`currentMonthKey`
(state/ui; data/mapping keeps its string version, not edited), `daysInMonth`
(format, targets), month and weekday arrays (format, TargetEditor,
DatePicker) are now in `domain/format.ts`; `categoryLabel` x2 in the
registers -> `domain/register.registerCategoryCell` (the bundles one is a
different function, kept); `amountStyle` x2 -> `ui/dropdown/dropdown.tsx`;
`CASH_TYPES` -> `domain/types.CASH_ACCOUNT_TYPES` (data/mapping's copy left);
`pairTransfers` x2 were a wrapper and its core, the wrapper is now
`pairRegisterTransfers`; `milliToCents` x2 -> data/mapping's. The transfer
TSV formatters stay separate on purpose (the archive's fixed format, pinned by
`features/backup/transfer/tsv.test.ts`).

### Structure (5e)

Final layout and rules: `docs/architecture.md` ("client/"). 334 files moved
with `git mv` (import specifiers rewritten by script, 833 of them), then
cross-feature imports routed through new `features/<x>/index.ts` barrels.
Kept in place for the data-layer work: `budget/data/`, `profile/api.ts` (and
its pure `model.ts`), with one-line re-export shims under
`budget/{domain,state,import}` so data/ compiles unchanged (budget-5rk).
Shared widgets used by several features (category/account/date dropdowns,
AmountPill, ClearedBadge, BalanceFormulaRow) moved to `ui/`; the People
filter, picker and pane form a `people` feature. One theme file
(`ui/theme.ts`, budget's tokens; the old shared theme's three differing
values kept under their own names so profile and combobox look the same).
Store, slice, history and store-backed hooks are `state/`; the DI runtime is
`shell/runtime.ts`.

God components, extracted test-first into pure functions (domain/*.ts or
*.logic.ts) and thin hooks (no React test renderer in the repo):
PlanScreen (`planFilter`, `planDrop`/`planGeometry` drop targets,
`planSelection`, `planSections`, `planRow`; `usePlanDrag`, `usePlanRowMenus`,
`usePlanSelection`, `usePlanUndo`, `usePlanNumpad`...), AccountsScreen
(`register`, `registerSelection`, reconcile logic; `useRegisterFilter`,
`useRegisterSelection`, `useReconcileSession`), InlineAddRow (`inlineAdd`,
`useInlineAdd`), plus ManagePayees, AccountEditModal, ImportScreen,
AddTransactionSheet, ConnectBank, the shell rail, ui/bits (one file per
primitive in `ui/primitives/`) and MenuPanes (one file per pane in
`features/settings/`).

### Metrics (before = branch start 08ff6fd, after = this branch)

| | before | after |
|---|---|---|
| largest non-data files | PlanScreen 2147, AccountsScreen 1651, InlineAddRow 892, MenuPanes 875, ManagePayees 843, shell 789, bits 777 | MoveMoneySheet 638, CategoryInspector 637, TargetEditor 560 |
| files > 600 lines (excl. data/) | 11 | 2 |
| longest component functions | PlanScreen 1351, AccountsScreen 1344, InlineAddRow 628, ManagePayeesBody 442, AccountEditModal 439, ImportScreen 426 | AccountsScreen 301, useInlineAdd 290, MobileMoveMoney 282 |
| functions > 300 lines | 11 | 1 (301) |
| test LOC in screens/features | 32 | 3088 (+ new domain tests) |
| client tests | 666 | 1054 (after the 5c/5d merge) |
| domain lint exceptions | 17 | 0 |
| import cycles | 3 | 0 (guarded) |
| hex literals outside theme files (quoted) | 165 | 75 (90 equal to a token replaced; the rest are avatar palettes, flag colors, tints; budget-65f) |
| ESLint warnings | 10 | 0 |

### Other items

- Session token (G22): native stores it in the Keychain
  (`platform/storage/secretStore.native.ts`, expo-secure-store ~58.0.3),
  migrating an AsyncStorage copy on first read; web keeps the cookie path.
  Same `sessionToken.ts` API, tested with an injected secret store. Not run on
  a device (simulator not allowed).
- Bugs fixed: budget-xef (format re-renders live), budget-xd6 (month note
  follows the budget: `domain/noteDraft`, MonthSummary keyed by budget),
  budget-fwf (New Budget refetches the list before switching, as Fresh Start
  does), budget-ipa (Escape closes the Assign dropdown: `ui/escapeToClose`,
  deferred so inner selects keep their own Escape). Left: budget-rnn,
  budget-qal.

### Intended visible changes

1. Amounts and dates re-render on a format change (xef); the transaction
   menu's match list (was a pt-BR/BRL Intl formatter and DD/MM) and
   Spending's day headers (was `Intl` pt-BR long date, "2 de fevereiro de
   2027") follow the prefs ("2 February 2027" / "February 2, 2027").
2. Portuguese UI strings in English: Plan menus and forms (Excluir, Cancelar,
   Ocultar, Restaurar, Renomear, "Nome do grupo/da categoria", the delete
   confirmation), the month names of `formatMonth`/`formatMonthLong` (Fev,
   Abr, Novembro... -> Feb, Apr, November: Plan header month labels, Reflect
   axis, date picker title, Recent Moves), target badge labels ("por mês",
   "até" -> "per month", "by") and one accessibility label.
3. The four bug fixes above.

### Regression pass (web, 2026-11-18, after merging main's 5c/5d)

API from this tree on :3141 against `budgetnew_dev`, Expo web on :8141,
`agent-browser` at 1440/900/390; shots in `docs/evidence/phase5e/<width>/`.
The dev DB drifted a lot since the parity pass, so the same 15 routes x 3
widths were also shot from `main` on the same API/DB/browser state and
diffed pixel by pixel: 12 routes identical (0.00%) at every width; reflect
differs only in month axis labels (Set/Out -> Sep/Oct), spending only in day
headers ("2 de fevereiro de 2027" -> "2 February 2027"), profile only in the
random avatar candidate seeds. Write flows, verified through the API/DB:
assign/undo/redo, Escape on the Assign dropdown, move money, target, drag
reorder, inline add/edit/delete, transfer (Casa; on Trabalho the API refuses
every transfer because its transfer payees point at Casa accounts since the
parity restore, budget-njc data), bulk flag, reconcile, payee merge, CSV
import (3 rows), backup export, People add/rename/remove, New Budget stays
(fwf), rename, switch, month note follows the switch (xd6), number and date
format re-render live and persist (xef). Not run: iOS, auth-on sign-in,
split editing, group drag. Seen, pre-existing on main: the add row defaults
to a closed first account (budget-dho).

## Access sign-in

Cloudflare Access is an identity provider for the API next to (and able to
replace) Google, so the e-mail allow-list can live in the Cloudflare policy
and someone already logged in to Access is signed in without a prompt.

### What was built

- `api/src/user/access.ts`: the verifier (pure; injected fetch and clock).
  RS256 only (`none`, HS* and anything else refused before a key is looked
  up), `kid` required, JWKS cached by kid for 10 minutes, an unknown kid
  refetches once (at most every 10 s), 5 s fetch timeout, every fetch failure
  fails closed. `iss` must be exactly `https://<team>`, `aud` must share a tag
  with `ACCESS_AUD`, `exp`/`nbf`/`iat` hold within 60 s, a non-empty `email`
  is required and a `common_name` (service token) is refused.
- `api/src/user/access-routes.ts`: `GET /auth/access?return_to=` (cookie,
  redirect), `GET /auth/access/native?redirect_uri=` (one-time code on the
  deep link) and `POST /auth/exchange` (`{ code }` -> `{ token, email }`).
  The exchange code is an HS256 JWT of kind `access_exchange`, 2 minutes,
  single use per process; the session token never goes in a URL.
- `GET /auth/providers` (`shared/src/contracts/user/providers.ts`):
  `{ access, google }`. A provider's routes answer 404 when it is off.
- Return targets (`safeLoginRedirect`): a safe relative API path or a URL on
  `APP_BASE_URL`'s origin; anything else falls back to the app origin.
- The Access `sub` is not stored (it is not a Google subject: putting it in
  `google_sub` would break the collision rule). A row signed in only through
  Access therefore keeps `google_sub` NULL, which `renameUnclaimedUser`
  reads as "never signed in" (members can rename such a person). Accepted
  for now; the fix is a provider-neutral subject column.
- Client: `features/auth/signIn.logic.ts` (decision, loop guard, URLs) and
  `useSignIn.ts`. Web + Access: one automatic top-level navigation to
  `/auth/access?return_to=<current URL>`, marked in sessionStorage; coming
  back signed out within 2 minutes shows the login screen with an error and a
  "Sign in" button instead of redirecting again. Google stays a button when
  both are on. Native: "Sign in" runs `/auth/access/native` in
  `expo-web-browser`'s auth session and swaps the code for the token.

### Allow-list: every place it is enforced

Superseded by "Multi-user" below (2026-11-18): `AUTH_ALLOWED_EMAILS` is now
Google's list only and Access sign-ins are not checked against it. What
follows is the original rule, kept for the record.

`isAllowed` (`user/config.ts`) was the single rule: with `AUTH_ALLOWED_EMAILS`
set the e-mail had to be on it (both providers); without it, everyone was
allowed only when Access was configured (the Cloudflare policy is the list);
neither = nobody. Call sites: the Google callback and `/auth/token`
(sign-in), `/auth/access` and `/auth/exchange` (sign-in), `currentUser`
and `cookieSessionUser` (every session request and the consent page),
`accessPrincipal` (every OAuth access token, MCP included) and the consent
POST in `oauth/authorize.ts`.

### Threat model

Cloudflare guarantees that a request reaching `/auth/access` passed the Access
policy and carries a fresh assertion it signed for that application. The API
does not trust the network for this: it verifies the signature against the
team's published keys, the exact issuer, the application AUD and the expiry,
and requires a human e-mail. Only the `Cf-Access-Jwt-Assertion` header is
read, never the `CF_Authorization` cookie or the query: the cookie can outlive
a policy change and is attacker-steerable in ways the edge-added header is
not. If the Access application is misconfigured as bypass (or the path is not
covered), no header arrives and the answer is 401 `access_assertion_missing`,
with no session. Revoking a person means removing them from the Cloudflare
policy, which stops new sign-ins, AND setting `users.status = 'disabled'`
(`requireUser` reads it on every request, so their live session and OAuth
grants stop at once); without the second step an existing session lives until
it expires (`SESSION_TTL_DAYS`, 30). Data routes stay bypassed at the edge
because native apps and MCP/CLI clients cannot complete an Access login and
the API already authenticates every one of them with its own session or
token; only the sign-in path needs Cloudflare.

### Open points

- `/auth/logout` clears only the API cookie; with an Access session still
  live, the next web visit signs straight back in. A sign-out should also
  visit `https://<api>/cdn-cgi/access/logout` (no sign-out button exists in
  the client today).
- On web, a 401/403 from `/auth/access` is a JSON page on the API host, not a
  screen in the app (the spec asked for JSON). The native route redirects
  errors to the app instead (`?error=<code>`), since its in-app browser would
  otherwise strand on that page.
- With several API replicas an exchange code could be redeemed once per
  replica inside its 2 minutes (it only ever yields the same person's
  session). PKCE on the native flow would close custom-scheme interception;
  not done, same as the Google native flow.
- The worker does not read any auth env; setting the Access vars there is
  harmless but not needed.

### Checks (2026-11-18)

shared 45 tests (was 43), api 895 (was 842) with `BUDGET_REQUIRE_TEST_DB=1`,
client 1070 (was 1054); tsc and eslint clean in all three;
`scripts/e2e-api.sh` exit 0; `expo export` web and ios OK. Browser check
against a local stub (`docs/evidence/access-signin/`): the API ran with
`ACCESS_CERTS_URL` pointed at `access-proxy.ts`, a local proxy that serves a
JWKS for its own key and injects a signed assertion on `/auth/access*`:
`01` signed in automatically on first visit; `02` with the proxy dropping the
cookie, the app came back signed out once and showed the error screen (no
second redirect); `03` the "Sign in" button then signed in.

## Landing page and sign-out (2026-11-18)

- `features/auth/LandingPage.tsx` is the one signed-out screen on web and
  iOS (split panes from the `lg` breakpoint, a single column below it). It
  also carries the sign-in error and the "Can't reach the API" state. What
  the gate shows is decided in `landing.logic.ts` (`gateView`): the page never
  renders while the session probe, the providers request or a redirect is
  still in flight.
- The client had no sign-out. Profile now has "Sign out" (`useAuthSession()`
  from the auth barrel, provided by `LoginGate`). Web: set
  `localStorage['budget.signedOutOnPurpose']`, then navigate to the API's
  existing `GET /auth/logout` (drops the cookie, redirects to the app).
  Native: drop the stored token and re-probe.
- Without the mark a web sign-out behind Access would be undone at once by
  the automatic redirect. `decideSignIn` therefore returns `show-login` (no
  error) while the mark is set, ahead of the loop guard. Pressing a sign-in
  button or any successful sign-in clears it. localStorage rather than
  sessionStorage so that closing the tab does not undo the sign-out.
- Sign-out ends the Budget session only; the Cloudflare Access session stays,
  so "Sign in" afterwards is usually one click with no Cloudflare prompt.
- Browser check used `docs/evidence/landing-login/stub-api.ts` (auth surface
  only, no Postgres), not the real API.

## Workflow bundle built into the image (2026-11-18)

The Temporal worker used to bundle its workflows with webpack on every boot
(`workflowsPath`). In the cluster that peak got `budget-worker` OOMKilled at its
384Mi limit about 28 s after each start, as soon as Temporal was reachable.

Now `deploy/Dockerfile.api` runs `bun run build:workflows`
(`api/scripts/build-workflow-bundle.ts` -> `api/dist/workflow-bundle.js`) and the
worker loads that file (`api/src/jobs/workflows/source.ts`: bundle if the file
exists, otherwise bundle at start, which is what local dev and tests do).

Measured locally (macOS arm64, worker connected and polling, peak RSS):
181 MB with the pre-built bundle, 327 MB without. `scripts/e2e-jobs.ts` passes
against a worker running from the bundle.

## Multi-user (budget-s1n, 2026-11-18)

The app was written for one household. It now has to serve unrelated people:
each signs in through Cloudflare Access (no sign-up), sees only the budgets
they own or that were shared with them, creates budgets and invites people.
This is the API and contract half.

### Sign-in: Access is the gate, the API keeps no list for it

Before: with `AUTH_ALLOWED_EMAILS` set (it must be whenever Google is on), an
Access-authenticated person who was not on that list got 403 `not_authorized`
from `/auth/access` and no user row; without the variable they were let in.
So an invited friend also had to be added to an env var and the API restarted.

Now:

- `/auth/access` and `/auth/access/native` do not consult
  `AUTH_ALLOWED_EMAILS`. A verified assertion is enough: the person gets a
  user row (`resolveOrCreateSessionUser`: role `user`, no budgets, nothing
  created for them) or, when their e-mail was invited to a budget or linked to
  a placeholder person, the existing row (`on conflict (email)`), so the shared
  budget is there on first sign-in.
- The list is Google's (`googleAllowed`): the Google callback and
  `/auth/token` require the e-mail on it; no list = nobody. Google is not
  behind Access, so without it anyone with a Google account could sign in.
- So that an Access person is not then refused on every request, a session
  minted by the Access routes carries `idp: 'access'` (an additive optional
  claim in the same HS256 JWT; older and Google sessions have none) and an
  OAuth grant stores how its approver signed in (`oauth_grants.idp`, migration
  0101). The per-request rule is `isAllowed(email, idp)`:
  on the Google list = yes; else `idp === 'access'` = yes while Access is
  configured; else (Google, or a session from before the claim) only the
  old Access-only fallback (no list configured and Access on). A Google
  session of someone removed from the list still dies at once, as before.
- Threat model, unchanged where it matters: the assertion is verified
  (signature, issuer, AUD, expiry, human e-mail, header only), so the only
  people who reach a user row are those the Cloudflare policy admits. What
  changed is that the API no longer second-guesses that policy: if the policy
  is widened (say, to any e-mail with a one-time PIN), anyone it admits gets an
  account with zero budgets and can create budgets and link a bank. Keep the
  policy as tight as the product needs. Revoking a person is unchanged
  (remove from the policy AND `users.status = 'disabled'`).
- The first user ever inserted is still seeded as `admin`
  (`resolveOrCreateSessionUser`). On an installation that already has an admin
  a newcomer is always `user`.

### "Has signed in" is `users.signed_in_at`, not `google_sub`

A person who only uses Access never gets a `google_sub`, so the old test
(`google_sub is null` = pending) showed them as pending forever and let any
member of a shared budget rename them (`budget_members_rename`). Migration
0101 adds `users.signed_in_at` (nullable, backfilled for rows with a Google
subject); `resolveOrCreateSessionUser` stamps it on first sight of an
authenticated principal, whatever the provider. `pending` and
`renameUnclaimedUser` read it. Rows written by syscd-app (shared database)
have it NULL until that person's first request here.

### Budgets list for a home page

`budget_list` (`GET /budgets`) returns `budgetListRowSchema`
(`shared/src/contracts/budget/outputs.ts`): the old row plus, always present,

- `is_owner: boolean`: the caller owns it ("My budgets") or not ("Shared with me");
- `owner: { user_id, name, email, avatar } | null`: for "shared by ..."; null
  only for a legacy budget nobody has claimed;
- `member_count: number`: people on the budget, owner included, the same set
  `budget_members_list` returns (placeholders and pending invitees count).

The other budget operations keep returning `budgetRowSchema`. A person with
no budgets gets `[]`. Nothing creates a budget on their behalf.

### Who can do what

- Reach a budget (read and write its data): the owner and the members. Nobody
  else, **the `admin` role included**. Before, an admin was let through
  `budgetAccess`, saw every budget in `GET /budgets` and could rename, archive,
  delete, restore, fresh-start any budget and remove anyone's members. That
  was fine for one household and is wrong for strangers sharing an
  installation. `admin` is now an operator role only: the jobs ledger
  (`/jobs`, `requireAdmin`), the app-wide sync window, and claiming legacy
  unowned budgets. To see someone's budget an admin has to be added to it like
  anyone else.
- Owner only: rename, archive, unarchive, delete, restore, fresh start,
  removing a person. The owner cannot be removed. Anyone else gets 404.
- Any member: everything inside the budget, adding a person (by e-mail =
  sharing it, or a placeholder), linking a placeholder's e-mail, renaming a
  person who has not signed in. Left as it was on purpose (the people list is
  shared like the rest of the budget); it does mean a member can share the
  budget onward and the owner removes whoever they do not want. If that is not
  wanted, gate `budget_members_add` with an e-mail and `budget_members_link_email`
  on `isBudgetOwner` (two lines in `routes/members.ts`).
- A member cannot leave on their own (only the owner removes). Not built.

### Other gaps closed

- Claim-on-first-login: any human session's `GET /budgets` used to sweep every
  unowned budget into that person's ownership. With open sign-in that would
  hand legacy or seed data to whoever arrived first. Only an admin's session
  claims now.
- `PATCH /connections/settings` (the app-wide sync window, one value for
  everybody's bank syncs) was open to every signed-in user: admin only now.
- A bank connection outlives its owner's membership: the connection summary
  and its transactions list showed accounts (names, balances, imported
  transactions) of a budget the connection's owner had been removed from, and
  the bank kept syncing into it. Removing a member now unlinks the accounts
  fed by that member's connections; the two reads and the disconnect 409 only
  consider accounts in budgets the caller can reach today (disconnect drops
  links it finds in budgets they cannot).

### Looked at, left alone

- `GET /users/:id/avatar` serves any user's photo to any signed-in user (ids
  are random UUIDs a person only learns through a shared budget; a removed
  member keeps the id). Narrowing it to people who share a budget is the fix
  if photos are to be private.
- The jobs ledger shows every run (connection ids, job input) to admins. It is
  the operator's tool and sits behind the Access admin policy.
- `linked_by` on accounts and members' names/e-mails are visible to everyone
  on the budget, by design.
- Background work never takes a budget id from a request: sync jobs are keyed
  by connection id and are enqueued after an ownership check, by the webhook
  (provider secret) or by the sweep; the repeat-rule tick walks all budgets.
- MCP tools and the CLI call the HTTP API with the caller's bearer, so they
  pass through the same guards.

## Home page (budget-ygu, 2026-11-18)

The client half of "Multi-user". Before: after sign-in the app dropped into
the budget shell at `/` and the shell chose a budget by itself (the persisted
one, else the first non-archived one; `fallbackBudgetId`). A person with no
budgets got a shell with spinners in it.

- **`/` is the home page, for everyone, every time.** The budget's phone
  landing tab moved from `/` to `/overview` (tab label "Overview"; "Home" now
  means one thing). Considered and dropped: keeping `/` as the budget and
  showing home only after a sign-in. It needs a "just signed in" flag, and a
  person with one shared and one own budget would never see the list again
  unless they went looking. The cost of the choice: one more tap after a cold
  start for someone with a single budget.
- **The active budget stays out of the URL.** Budget routes are `/plan`,
  `/accounts?account=` and so on, as before; the id is persisted (KV
  `budget.activeBudgetId`) by `switchBudget`. Putting it in the path would be
  the proper deep link, and is a rewrite of every route and link in the shell.
  So a deep link opens "the budget this device last had open"; with none, or
  one the person cannot reach any more, it lands on home.
- **The shell never picks a budget** (`shellGate` replaces
  `fallbackBudgetId`). An id missing from a list that is still being fetched
  waits instead of bouncing (budget-fwf); creating a budget refetches the list
  before switching, on home as in the settings menu
  (`state/refetchBudgets.ts`). Archiving or deleting the active budget, or
  losing access to it, sends the person home rather than into some other
  budget. `restoreActiveBudget` no longer overrides a budget chosen in this
  session (home switches, then the shell mounts and restores).
- **Archived budgets** keep the treatment the switcher gave them: their own
  section (collapsed on home), name plus archive date, still openable. The
  date was printed from the raw timestamp (`18T22:03:58.457Z/11/2026`) in the
  switcher; both places cut it to the day now.
- **Inviting is the existing People pane**, opened in a sheet from a card.
  Any member may add a person (the API's rule), so every live card has the
  button: "Invite" for the owner, "People" for a member. The pane's old line
  about `AUTH_ALLOWED_EMAILS` was wrong since "Multi-user"; it now says what
  happens (the budget is on the invitee's home page at their sign-in; nothing
  is sent). Member add/remove/link invalidate the Budgets list, which carries
  `member_count`.
- **Owner-only controls are absent, not disabled, for members**: Fresh Start
  row, rename field, archive/delete section (Plan Settings shows the name and
  who the owner is), backup import. Format prefs stay: they are per device.
- **The sync-window control needed no change.** The pills in
  `SyncWindowControl` / `bank/SettingsPanel` / `ConnectionSettingsScreen`
  write the per-bank window (`PATCH /connections/:id/settings`, the caller's
  own connection). Nothing in the client calls the admin-only
  `PATCH /connections/settings`; `useUpdateSyncWindowMutation` is exported and
  unused. Checked against the running API as a non-admin: the app-wide PATCH
  answers 403, the app-wide GET (shown as "Default (...)") 200.
- **Sign-out from Profile** lands on home at the next sign-in: on web the
  API's logout redirect goes to the app root; on native the router is moved
  to `/` first.

Evidence: `docs/evidence/home-page/` (screenshots; `access-proxy.ts` is the
Access stub with `/__as?email=` to switch identity).

## Rail layout (budget-vio, 2026-11-20)

The rail follows the usual SaaS sidebar order (positions only; colors and
content are ours): app title (logo + "Budget", no longer a trigger) with the
collapse-sidebar button on its right (desktop), nav rows with icon + label,
account groups, and pinned at the bottom the account row (my avatar, my name,
the current budget, up/down chevron). Collapsed strip: logo, expand button
under it, icon nav, avatar at the bottom.

- **The account row is the settings-menu trigger** (label still "Open
  settings menu"). The menu opens upward: anchored by its bottom edge 6px
  above the row, body height capped by the room left in the window (status
  bar inset and, on native, the keyboard included); under 200px of room it
  covers the row instead. The math is `shell/menuPlacement.logic.ts`.
- **Root pane in sections split by hairlines** (the BUDGET / MANAGE labels
  are gone): budget name, "All budgets" (was a separate row in the rail
  body; `goHome` is now on `useBudgetShell()`), the budget rows; the
  settings rows; the email, "Profile"; "Log Out" last. Root rows are dense
  (7px padding) so the whole root fits a 900px window without scrolling.
  Every earlier row is still there, "Account Settings" included.
- **One sign-out sequence**: `useSignOutAndLeave()` in `features/auth`
  (native: `dismissTo('/')` first; web: the API redirect), used by the
  Profile page and the menu's Log Out.
- The rail no longer links the avatar to `/profile`; the menu's "Profile"
  row does.

## Password sign-in and user management (budget-uns, 2026-11-20)

API and contracts half of epic `budget-bst`: e-mail + password sign-in next
to Google and Cloudflare Access, Google linking for admin-managed users, and
`/admin/users`. Contracts: `shared/src/contracts/user/password.ts`,
`admin-users.ts`; password rules: `shared/src/password-policy.ts`.

### Identity and storage

- One user row per e-mail, unchanged. The password is an extra credential in
  a NEW table (migration `0102_password_login.sql`; `public.users` is not
  altered, the database is shared with syscd-app):
  `user_passwords (user_id PK -> users ON DELETE CASCADE, password_hash,
  must_change, temp_expires_at, session_version, changed_at, created_at)` and
  `auth_login_throttle (email PK, failures, locked_until, last_failure_at)`.
- "Admin-managed" = has a `user_passwords` row. Only an admin creates one
  (create user, or reset the password of any user). No sign-up, no recovery,
  no e-mail sending.
- Hashes: argon2id through `Bun.password` with Bun's defaults (64 MiB, t=2).
  `AuthConfig.passwordHashCost` lowers the cost for tests only; it is never
  read from env. Passwords, temporary passwords and hashes are never logged or
  returned, except the one-time `temp_password` field of the admin responses.

### Sessions

- A password session is the same HS256 session JWT with `idp: 'password'` and
  `pwv` = the row's `session_version`. `verifySession` refuses a password
  session without `pwv` (it is never downgraded to an unmarked session).
- The per-request rule lives in `api/src/user/session-gate.ts`
  (`decideSession`, pure; `admitSession` / `admitGrant` load what it needs):
  - `password`: password login on, user exists and is active, password row
    exists, and (sessions) `pwv` equals `session_version`. Grants approved from
    a password session (`oauth_grants.idp = 'password'`) follow the same rule
    without the version and are revoked on a password change or reset.
  - otherwise the old config rule (`isAllowed`) with no DB read; an unmarked
    (Google) session off `AUTH_ALLOWED_EMAILS` passes only for an active
    admin-managed user while password login is on.
  - Call sites: `currentUser` and `cookieSessionUser` (so `requireUser`,
    `/auth/me`, `principalFromRequest`, `rejectUnlessActiveSession` and the
    consent page), `accessPrincipal` (OAuth tokens, MCP included) and the
    consent POST in `oauth/authorize.ts`.
  - The row is then resolved by `resolvePrincipalUser`: password principals
    use `findSessionUser` (UPDATE ... RETURNING, never INSERT); others keep
    `resolveOrCreateSessionUser`. A password session can never create a row.
- Deviation from the epic: instead of `sessions_valid_after` compared with the
  token's `iat`, the row holds an integer `session_version` copied into the
  token (`pwv`). `iat` has one-second resolution, so "invalidate everything
  older, then re-issue the caller's session" cannot be expressed without either
  killing the fresh session or keeping others issued in the same second (and
  hono refuses a future `iat`). Behaviour is the one the epic asks for.

### Google linking

`googleSignInAllowed` (session-gate.ts): the Google web callback and native
`/auth/token` admit an e-mail on `AUTH_ALLOWED_EMAILS` (as before) or one that
belongs to an active admin-managed user while password login is on.
`email_verified` stays mandatory; the row is resolved with
`resolveOrCreateSessionUser` as before (same row, `google_sub` back-filled, a
different `google_sub` still 403). Per request the unmarked session passes
through the same exception. Removing the password row, disabling the user or
`AUTH_PASSWORD_LOGIN=0` ends it. The reverse holds: a Google/Access user given
a password by an admin signs in with it into the same row.

### Endpoints

All api-only (no CLI, no MCP). Errors are `{ error, code }`.

| Operation | Method, path | Input | Output |
|---|---|---|---|
| `user_auth_password_login` | POST `/auth/password/login` (pre-gate) | `{ email, password, session?: 'cookie'\|'token' }` | `{ status: 'signed_in', email, token? }` or `{ status: 'password_change_required', email, change_token, expires_in }` |
| `user_auth_password_complete` | POST `/auth/password/complete` (pre-gate) | `{ change_token, new_password, session? }` | `{ status: 'signed_in', email, token? }` |
| `user_auth_password_change` | POST `/auth/password/change` (post-gate) | `{ current_password, new_password }` | `{ ok: true, token? }` |
| `user_admin_users_list` | GET `/admin/users` | `{}` | `AdminUser[]` |
| `user_admin_users_create` | POST `/admin/users` (201) | `{ email, name?, role? }` | `{ user: AdminUser, temp_password }` |
| `user_admin_users_update` | PATCH `/admin/users/:id` | `{ id, name?: string\|null, role?, status? }` | `AdminUser` |
| `user_admin_users_reset_password` | POST `/admin/users/:id/reset-password` | `{ id }` | `{ user: AdminUser, temp_password }` |
| `user_admin_users_delete` | DELETE `/admin/users/:id` | `{ id }` | 204 |

`AdminUser`: `id, email, name, role, status, has_password,
must_change_password, temp_expires_at, locked_until, has_google, signed_in_at,
last_seen_at, created_at`. `GET /auth/providers` gained `password`; `/me`
(and the other profile operations) gained `has_password`.

- Login: `session: 'cookie'` (default) sets `budget_session`, no token in the
  body; `'token'` returns `token` and sets no cookie. A correct, unexpired
  temporary password returns a change token (HS256, kind `password_change`,
  10 minutes) and no session. Kind separation keeps it out of
  `verifySession`, `verifyAccessToken` and the Access exchange; completion
  is a compare-and-swap on `session_version`, so it works once.
- Failure codes: 401 `invalid_credentials` for unknown e-mail, no password,
  wrong password and disabled user (each path runs exactly one argon2
  verification, against a dummy hash when there is nothing to check);
  401 `temp_password_expired` only after the temporary password was right;
  401 `invalid_change_token`; 400 `password_too_short` | `password_too_long` |
  `password_is_email` | `password_too_common` | `password_unchanged`;
  400 `no_password` (change, account without a password); 409 `conflict`
  (change raced another change); 403 `origin_not_allowed`; 415
  `unsupported_media_type` (login/complete/change need `application/json`);
  403 `forbidden` (change by an OAuth token or the service token); 404 `not_found` while password login is off; 429
  `too_many_attempts` with `Retry-After`.
- Admin: 401 `unauthorized`; 403 `forbidden` (not admin, or not a first-party
  session: OAuth tokens and the service token are refused); 403
  `origin_not_allowed`; 404 `not_found` (unknown id, synthetic rows
  `svc-budget-mcp@syscd.local` / `dev@localhost`, placeholders); 409
  `user_exists`, `cannot_modify_self`, `last_admin`, `user_has_data` (any row
  referencing the user other than `user_passwords`: budgets, memberships,
  accounts, avatars, OAuth grants...; disable instead),
  `password_login_disabled` (create and reset while `AUTH_PASSWORD_LOGIN=0`).
  Create, update, reset and delete run in one transaction under an advisory
  lock and re-read the caller inside it (still an active admin, else 403), so
  two admins cannot demote each other to zero and a request in flight from an
  admin just demoted or disabled does not complete. Create refuses the
  reserved e-mails (`svc-budget-mcp@syscd.local`, `dev@localhost`) with 400
  `invalid_input` before any insert; the other operations answer 404 for those
  rows. Delete locks the user row, then checks every foreign key to users
  (except `user_passwords`) and the non-FK reference `jobs.job_runs.requested_by`
  (`user:<id>` / `admin:<id>`), then deletes, in the same transaction; a
  referencing insert racing it waits for the row lock and then fails its FK
  check instead of being cascaded away. `last_admin` is effectively a
  defence in depth: the in-transaction check makes the caller an active admin,
  so the last one can only be the caller, who hits `cannot_modify_self`. Every action logs one JSON line
  (`event: admin_user_action`, actor, action, target, changed fields).

### Rules

- Chosen passwords: 12 to 128 code points, no composition rules, not the
  e-mail, not the current/temporary password, not in a small built-in list of
  common passwords (`shared/src/password-policy.ts`).
- Temporary passwords: server-generated, 20 symbols from a 31-letter alphabet
  without look-alikes in four groups (`abcde-fghjk-mnpqr-stuvw`, about 99
  bits), stored hashed, expire after 7 days, force a change, returned once.
- Throttle per normalised e-mail (unknown e-mails too): every attempt is
  RESERVED before any verification (`reserveAttempt`: one transaction that
  row-locks the e-mail's `auth_login_throttle` row, refuses while it is
  locked, otherwise counts the attempt). The 5th consecutive attempt starts a
  1-minute lock itself, and each later admitted attempt (one per lock window)
  doubles it, up to 15 minutes. So at most 5 argon2 verifications run before
  the first lock and one per window after it, whatever the concurrency; a
  refused attempt is a 429 with `Retry-After` and runs no argon2. A correct
  password (also a correct temporary one, or the correct current password at
  change) and an admin reset clear the count; rows idle for a day are pruned.
  The same budget guards `/auth/password/change` (keyed by the caller's
  e-mail). `/auth/password/complete` has only the address budget: its
  credential is the signed, single-use, 10-minute change token, not a guess.
- Per client address (CF-Connecting-IP, else the socket): at most 30
  attempts (not only failures) per 15 minutes per process, reserved before
  verification (in memory, synchronous, so atomic within a process).
- Origin: login, complete, change and every `/admin/users` route refuse an
  Origin header outside the trusted list built in `app.ts`: the app origin and
  `ADMIN_ORIGIN`, plus the fixed localhost dev origins only when the app
  origin itself is localhost (local dev). The CORS list is unchanged apart
  from `http://localhost:5191` (the admin dev server) and now exposes
  `Retry-After`. The cookie is SameSite=Lax on the parent domain, so a sibling
  subdomain would otherwise be same-site. Login, complete and change also
  require the media type `application/json` exactly (parameters ignored).
- Changing a password (self or reset) bumps `session_version` (ends the
  user's other password sessions), revokes grants approved from a password
  session, and re-issues the caller's password session (cookie, or `token` in
  the body for a Bearer caller).
- Env: `AUTH_PASSWORD_LOGIN` (default on when auth is on; `0/false/off/no`
  = off: routes 404, password sessions invalid, no Google exception; another
  value refuses to boot). Password login is never on with auth disabled.
  It does not count as a sign-in provider for the boot check: the first admin
  still comes from Access or Google.

### Migration probe

`MIGRATION_SIGNATURES` now accepts a list of probes (all must exist); 0102
probes both `public.user_passwords` and `public.auth_login_throttle`.

### Known limits

- Anyone who knows an e-mail can keep it locked by sending a wrong password
  once per lock window (at most 15 minutes at a time, by design). Only time
  or an admin reset unlocks it; Google and Access sign-in are unaffected.
- The per-address limit trusts `CF-Connecting-IP`. Behind Cloudflare that is
  the client; a request reaching the API directly can set it to anything, so
  the per-e-mail budget is the real bound. The limit is per process (several
  replicas each allow 30).
- Deleting a user and recreating one with the same e-mail at the same moment
  as a sign-in can race (rated low risk in review): a sign-in resolving the
  old row may fail with 401 and must be retried. A managed Google session
  admitted just before its row is deleted is resolved through the
  create-on-resolve path of Google sessions and could recreate a plain row.

### Out of scope

Password recovery, e-mail sending, self sign-up, MFA, changing an e-mail,
users setting a first password themselves. The OAuth consent page still
sends a signed-out browser to Access or Google (a password user signs in on
the web app first; the cookie is shared).

## Own Pluggy keys (budget-lqi, 2026-11-20)

The owner's decisions are in the task: own keys by default, the shared keys
only with feature `shared-pluggy-key`, one own key set per user, own keys win,
feature off pauses (never deletes) shared-key connections, own-key connections
get no webhooks, secrets encrypted by the API with a master key from the
environment. What follows are the choices the task did not dictate.

### Storage and encryption

- `public.connection_credentials` (migration 0104), primary key
  `(user_id, provider)`: one own key set per user (and per provider, so a
  second aggregator needs no new table). `client_id` is plain: it is shown
  back to the user and handed to the connect widget. The secret is
  `secret_ciphertext` + `secret_nonce` + `key_version`.
- `core/secret-box.ts`: WebCrypto AES-256-GCM, a random 96-bit nonce per
  value. Additional authenticated data binds the ciphertext to its row: user,
  provider, client id (`keys.ts`) and the key version (added by the box), so
  a ciphertext copied onto another row, or a row whose client id or
  `key_version` was edited, does not decrypt. Chosen before any data exists:
  changing it later means re-encrypting. `key_version` is stamped (1 today); the box already opens by
  version from a keyring, so rotation later is "configure two keys, re-seal,
  drop the old one" with no schema change. Only one env var exists today.
- `CREDENTIALS_ENCRYPTION_KEY`: 32 bytes, base64 or hex. `secrets-env.ts`
  (API and worker): missing in a cluster = boot fails; missing locally = boot
  continues and saving or using own keys answers 503
  `credentials_key_missing`; set but malformed = boot fails everywhere.
  Changing the key makes stored secrets unreadable (the user saves again);
  nothing else is lost, since the connection rows keep their client id.

### Which key set

- `connections.key_source` ('shared' | 'own', default 'shared' = the backfill)
  and `connections.key_client_id` (the own client id the item was created
  with). The client id is recorded because "one own key set per user" can be
  REPLACED by another application's keys, and the old items are then
  unreachable: without it a sync would fail with a provider 404 and mark the
  bank broken instead of saying which keys are missing.
- New connection: own if saved, else shared if the feature is on, else 403
  `own_keys_required`. That is connect-token's choice; register does not
  repeat it blindly, because own keys can be saved or deleted while the widget
  is open: it probes the item (`hasItem`, one GET item) with every key set
  the caller may use now, own first, and records the one that reaches it.
  None reaches it: 409 `item_not_reachable`, nothing stored. The client
  never names a key set. connect-token with another user's `itemId` is 404. Existing connection (sync, sweep, upstream, re-auth
  connect-token, re-register, delete): always the recorded key set. Adding own
  keys does not move a shared-key connection: Pluggy has no item transfer, so
  the person connects that bank again.
- The feature gates connecting and syncing, not cleanup: deleting a paused
  shared-key connection still removes the item upstream with the shared keys.
  An own-key connection whose keys are gone is disconnected locally only.
- The port gained `verifyCredentials()`, `hasItem()` and the registry entry
  `create(credentials?)`; `getAggregator(provider)` with no credentials is the
  shared-key adapter exactly as before, so `webhook.ts` is untouched.
- Own keys run on the installation's `PLUGGY_BASE_URL` / `PLUGGY_SANDBOX` and
  never on `PLUGGY_ITEM_IDS`. Blank values of those count as unset for own
  keys only (`loadPluggyOwnConfig`): the 1Password item leaves `PLUGGY_*`
  empty and own keys must work then. The shared loader still takes blanks
  literally (budget-hd3, not fixed here).

### Paused

- New `connections.status` value `paused` (the column is free text) with a
  `status_message` per key set (`PAUSE_MESSAGES`), and sync state `paused`.
- Evaluated at use time, not on the admin toggle: `reconcileKeyAccess(db,
  userId)` (one feature read, two idempotent updates) runs in the sync
  activity, the sweep check, connect-token, upstream, the lists, get, sync
  status and sync/reimport requests. Paused rows stay in the sweep's list, so
  the 6-hourly sweep both pauses (feature turned off, nobody opened the app)
  and resumes (and then enqueues a sync whatever the watermark says). A
  paused connection never reaches the provider: the sync run succeeds with
  `skipped: 'paused'`, a manual sync is 409 `connection_paused`.
- Pausing remembers the row's status, message and quota pause-until in
  `connections.paused_from` (jsonb, NULL unless paused); resume restores
  them, so an `unauthorized` or quota-paused bank does not come back looking
  healthy. Nothing remembered: `connected`.
- Only the reconcile leaves `paused`: `setConnectionStatus` skips paused rows
  (as it does disconnected ones), so a webhook status event or a sync that
  finishes after the pause cannot un-pause. A disconnect and a fresh register
  of the same item are the two other exits.
- The sweep also takes own-key connections in `error` (shared-key ones still
  wait for a webhook or the user): with no webhook, nothing else would ever
  retry them.
- The same mechanism pauses own-key connections when their key set is deleted
  or replaced, and resumes them when the same client id is saved again.

### Webhooks

`connect-token` never sent a `webhookUrl` (shared-key items get their events
through the URL set once in the shared application's dashboard), so "own-key
connections pass no webhookUrl" was already true; it is now stated in the
handler and pinned by a test. A person who sets a webhook in their own Pluggy
dashboard would need the shared secret, which they do not have.

### Migration 0104 and the old app

- Turns the feature on (`feature_overrides`, value true, `on conflict do
  nothing`) for every user with a shared-key connection, in any status: all
  connections before this migration were created with the shared keys. A
  re-run never overrides a value an admin set.
- syscd-app shares the database: it names none of the new objects, its
  inserts get `key_source = 'shared'`, and its sweep reads only
  `status = 'connected'`, so it leaves paused rows alone. Two limits while it
  still runs: it does not know the feature (its worker keeps syncing a
  shared-key connection until this API pauses it), and its sweep will ask the
  shared application about own-key items (the provider answers not found;
  counted as a sweep error, no status change).

### Out of scope

The client screen for own keys (the next task; the client only got the
`paused` labels so existing screens keep working), admin changes, a rate-limit
queue per credential, key rotation tooling.

## Separate server and iOS app releases (budget-vnma, 2026-11-23)

Why: `task release` bumped `api/VERSION` and `client/VERSION` in lockstep and
`release.yml` ran the EAS build + App Store submit in the same run as the
images (gated only by `EAS_ENABLED`, which is on). Every server hotfix (the
migration 0106 fix among them) therefore also built and submitted the iOS
app. The two now ship independently.

- Server release = web + api + admin images + the `k8s/values.yaml` pin.
  Version `api/VERSION`, tag `v<VERSION>`, reported by `/health`. `task
  release` bumps only that file; `version.yml` tags and dispatches
  `release.yml`, which no longer has an app job. CHANGELOG.md sections and
  the "latest" GitHub release stay server-only (`release-changelog.ts` reads
  `v20*` tags and drops `release: app-v` commits).
- iOS app release = `client/VERSION`, its own `YYYY.MM.DD[-NN]` sequence, tag
  `app-v<VERSION>` (release.yml's `v*` tag trigger does not match it),
  workflow `app-release.yml` (push to main changing `client/VERSION`, or
  `workflow_dispatch` to rebuild), EAS build + submit still gated by
  `vars.EAS_ENABLED`. `task release:app` bumps only that file. GitHub release
  `app-v<VERSION>`, `--latest=false`, notes generated from the previous app
  tag.
- `scripts/release-bump.ts` takes the target (`api|client`) and writes only
  that file (`scripts/release-bump.test.ts`; `task test` runs it).
- The web image is built from `client/` but ships with the server release, so
  it shows the server version: `Dockerfile.web` passes `api/VERSION` as
  `WEB_RELEASE_VERSION`, which `app.config.ts` prefers over `client/VERSION`.
  EAS never sets it, so the iOS app shows its own version. Nothing requires
  the two files to be equal.
- Rejected: one version with an "app too" flag. The App Store marketing
  version only needs to move when the app changes, and a flag on a shared
  version keeps the two coupled.
