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
| API image | `container build --dns 1.1.1.1 -f docker/Dockerfile.api -t budget-api:phase0 .` (repo root) | built; `container run -p 127.0.0.1:3101:3100` answered `{"message":"Hello, Docker!"}` |
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
- `docker/Dockerfile.api` also runs the worker: `bun src/worker.ts`. It copies
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
| `container build --dns 1.1.1.1 -f docker/Dockerfile.api -t budget-api:phase2 .` | built; image holds 33 migrations; boot guard fires without env |

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

Now `docker/Dockerfile.api` runs `bun run build:workflows`
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

## Transfers between own accounts (budget-mit6)

- The card-payment pairing became a general transfer matcher
  (`api/src/budget/domain/transfer-matcher.ts`, pure; `transfer-links.ts`
  loads/writes). Pairs cash↔cash, cash→card, card↔card in one budget: equal
  and opposite amounts, ≤3 days. Resolution per amount bucket: unique pair,
  then Pluggy evidence (`category` / `operationType` in the raw payload) as a
  tie-break, then ordinal pairing of repeats inside one account pair (date,
  bank time, id), then a payee rule takes the closest candidate. Auto-link
  needs both rows untouched and: unique, or ordinal with transfer evidence on
  both sides, or evidence with strong evidence ("Same person transfer",
  "Credit card payment", `PAGAMENTO_FATURA`) on both. A contradicting bank
  category vetoes auto-link except cash→card. Everything else is a
  suggestion (`sure` / `choose` / `one_side`). Payee text is never read.
- Suggestions are computed at read time (register list and
  `GET /transfers/suggestions`), never stored: editing or categorizing a row
  updates them with no invalidation logic. Stored are only decisions
  (`transfer_marks`: dismissed / outside / manual) and links with their undo
  state (`transfer_links`: previous payee, category, shadow `blocked`).
- A payee rule row with no other side yet is derived as `transfer_pending:
  waiting` while within `wait_days`: the client engine skips it like an
  on-budget transfer (no category, no Ready to Assign effect). After the
  window, policy `outside` makes it a transfer to an account outside the
  budget: no category asked, but it moves Ready to Assign like any money
  leaving or entering the budget (same as a transfer to an off-budget
  account); policy `review` turns it into a one-side suggestion. Chosen over
  a synthetic "outside" account: no fake account rows, nothing to clean up,
  and a later-arriving other side still links.
- A rule covers rows created after it was set (`transfer_rule_since`);
  "Apply to past rows" clears it. Undone links are marked `manual`: still
  suggested, never auto-linked again.

## Transfer account rules by bank (budget-zkts)

- The person's rules, enforced in the matcher's `fits` (`pairViolation`), so
  breaking candidates are dropped before any tie-break: (1) a card only
  receives (card→card is no longer paired; a lone card outflow is never a
  one-side suggestion, also when its payee has a rule: such a row can never
  pair); (2) cash→card only within one bank (any checking, savings or
  cash-in-hand account paying a card); (3) checking→checking only
  across banks. Rule 3 is judged on the account type, not the matcher's
  `cash` kind: savings and cash-in-hand accounts are `cash` too, and a move
  between a checking and a savings account of one bank (either way) is an
  ordinary transfer that keeps linking and being suggested.
- Bank of an account: `bankKey(accounts.institution ?? connections.institution)`
  (`domain/bank-key.ts`: accents/punctuation/suffixes stripped, known brands
  mapped, so "Itaú Unibanco PF" = "itau", "Nu Pagamentos S.A." = "Nubank").
  With no label on either side, the same `connection_id` means the same bank.
  Otherwise unknown: rules 2 and 3 do not apply (old behaviour).
  One side labelled and the other not, on the same connection: the same bank
  (the unlabelled account is taken to share the connection's bank); with
  different connections it is unknown. Pinned in `transfer-matcher.test.ts`.
  How "same bank" is decided (labels versus connection id) stays open until
  production data and an owner decision.
- Owner decision (refused pairs): a pair a rule refuses is never linked
  automatically (not by evidence, not by an `auto` payee rule), but it is not
  hidden: a row that stays unlinked carries every refused candidate it has.
  A row without a suggestion gets a `refused` one (`basis: 'refused'`, `sure`
  when the pair is mutual and neither row has another candidate, `choose`
  otherwise); a row already in a choose group or in a pair left for the
  person gets the refused candidates added and becomes `choose`; a row whose
  only partner is refused is offered it even when that partner has allowed
  candidates of its own. Each refused candidate carries the rule it breaks
  (`rule`: `card_outflow` | `card_payment_other_bank` | `cash_same_bank`).
  Refused candidates never change which allowed pair is linked, and a row that
  is linked is never offered one. They count as suspected transfers in the
  register chip and the suggestions list, and the row is then not also a
  one-side or waiting/outside rule row. Only pairs main would have matched
  are ever refused candidates (card→card, cash→card
  at another bank, checking→checking at one bank); a card outflow against a
  cash inflow (refund, cash advance) was never a transfer candidate and is
  none now. Confirming
  goes through `POST /transfers/link` with `counterpart_id` and returns the
  existing warning. Contract change is additive (new basis value, optional
  `candidates[].rule`). A released client has no text for `refused`: its
  "Why:" line falls through to "no matching row in your accounts" (wrong but
  harmless; the link action still works), so the client should add a reason
  per `rule` (e.g. "different banks").
- Known limit of "same bank" (follow-up, not fixed here): bank labels come
  from the account's institution, else the connection's, and the same
  connection counts as one bank when labels are missing. A connection that
  holds several banks with unlabelled accounts would be treated as one bank.
  Production data (read by the owner) has one bank per live connection and a
  label on every linked account, so it does not occur today. A fix would
  store the bank per account at link/sync time and treat the MeuPluggy
  wrapper connection as unknown.
- Re-running the matcher never touches a link that already exists, even one
  that breaks these rules: only unlinked rows are candidates and nothing
  unlinks (tested in `budget/routes/transfers.test.ts`).
- A fixed-account payee rule is the person's choice and skips rules 2–3.
  `POST /transfers/link` with a counterpart never blocks; a pair that breaks
  a rule is linked and listed in `warnings`.

## Category suggestions engine (budget-fvtx)

- `connection_transactions.raw_payload` (0105) is the provider transaction
  object verbatim (Pluggy's `.passthrough()` schema). The documented Pluggy
  transaction object has **no location** (no latitude/longitude, no address):
  `merchant` is `{name, businessName, cnpj, cnae, category}` and
  `paymentData` carries participant bank identifiers. **Decision: there is no
  map panel.** The Categorize page shows a merchant panel instead, so the bank
  facts exposed to the queue and to the model are, when the bank sent them:
  merchant trade name, merchant legal name (`businessName`), merchant CNPJ,
  business category (and CNAE), the provider operation type and the PIX
  counterparty name of the row (receiver for money out, payer for money in).
  `SuggestionRow.bank` (`BankFacts`, every field optional, null for
  hand-entered rows) carries them to budget-edxg and `get_transaction`
  returns the same shape. No location fields are invented. The merchant CNPJ
  is exposed by this product decision; participant document numbers (CPF),
  bank branch/account/routing numbers, reference ids, boleto lines and card
  numbers are still dropped before text leaves the server. The tool layer
  whitelists exactly those facts.
- The candidate set is the app's own "needs a category" rule, not a second
  definition. The rule is `needsCategory` in
  `shared/src/domain/category-needs.ts`; the register cell
  (`client/src/domain/register.ts`) and the categorizer's SQL both use it.
  The SQL keeps only the register's scope and the run's bookkeeping: live,
  uncategorized, non-upcoming outflows (`amount <= 0`; inflows go to Ready
  to Assign) on live, open, on-budget accounts, without live split legs,
  linked transfers, an on-budget `Transfer : <account>` payee, or a
  Reconciliation/Balance adjustment payee. The transfer-pending half is NOT
  re-implemented in SQL: `transferOverview` — the same transfer plan the
  register reads `transferPending` from — computes the pending ids
  (`waiting`/`outside`) and the query excludes exactly those, which closes
  the old divergences (a `manual` mark is not pending; a dismissed mark under
  an active payee rule is not pending; a rule row with an open counterpart is
  not pending; the plan's `today` is the server's date). `candidates.test.ts`
  builds one fixture set, calls the shared predicate with each row's facts
  (pending from `transferOverview`) and compares the verdict with the SQL
  candidate set — no api → client import. A transaction that already has
  suggestions is skipped unless the run is an explicit re-classify (`force` in
  the job input).
- A run takes a keyset snapshot at prepare: the newest candidate's
  `(date, id)` bounds the walk and each chunk continues below the last
  processed row (`order by date desc, id desc`). Rows inserted mid-run cannot
  shift the window (offset pagination double-billed new rows and skipped
  others) and a transaction categorized meanwhile just disappears. A row
  categorized mid-run is refused by the write's `FOR UPDATE` guard.
- The existing payee rule (`suggestedCategoryForPayee`) answers first: a
  payee-rule transaction gets one `payee_rule` suggestion (confidence 1,
  provider/model null) and the model is not called — but only when the rule's
  category is still visible; a hidden one falls through to the model. The rule
  is called, never duplicated.
- `category_suggestions` is keyed `(transaction_id, rank)`, ranks 1..3.
  Re-runs upsert pending rows in place and delete pending ranks above the new
  answer. A transaction with ANY decided row (accepted or dismissed) is never
  re-asked, never overwritten at its rank and never hidden behind a new
  pending row: the chunk checks before the model call, and the write refuses
  as the last line of defence. An answer whose ids are all unknown is
  `bad_response` and writes nothing, so it cannot delete pending rows an empty
  (valid) answer may clear. The read path filters hidden/deleted categories
  and groups, **card-payment and internal categories/groups**
  (`is_credit_card_payments`, `internal`: the card-payment setup writes both)
  and deleted accounts too. Internal envelopes are never offered to the model
  nor accepted from an answer: booking a card payment there would turn a
  transfer into spending. No check constraint on `source`/`status`: the value
  lists are code.
- The category list a suggestion may name is the app's assignable-category
  set: live, visible, `internal = false`, in a live visible group with
  `is_credit_card_payments = false` and `internal = false`.
- Every classification attempt is recorded in `categorize_attempts` (0112),
  one row per transaction: outcome `suggested` / `no_suggestion` / `failed`,
  the failure kind, an attempt counter, the model and the SQL-computed
  payee+memo fingerprint. A separate table (not a rank-0 marker in
  `category_suggestions`) because a no-suggestion attempt has no category and
  the suggestion table is keyed per category rank; a marker would force
  nullable category/rank columns and make every existing query exclude it.
  A normal run skips `no_suggestion` rows while the payee/memo fingerprint is
  unchanged, and skips `failed` rows while the exponential backoff (10 min,
  20 min, … capped 6 h) has not elapsed or the counter reached
  `CATEGORIZE_MAX_ATTEMPTS = 3`; `force` resets the counter and re-asks. This
  is what makes the newest-first 100-transaction cap walk the backlog across
  runs instead of re-billing the same empty/failed rows. `readCategorizeAttempts`
  and `SuggestionRow.attempt` let the queue page tell "not classified yet"
  (no attempt row) from "classified, no suggestion" (`no_suggestion`).
- Re-run rule (budget-edxg must know): once a person accepted or dismissed
  ANY suggestion of a transaction, that transaction is FROZEN forever. A
  normal run skips it (it has suggestion rows), a forced run skips it
  (`hasDecidedSuggestion`), and `replaceSuggestions` refuses every write. It
  stays frozen when the accepted category is later cleared, when every
  suggestion was dismissed, and when its only pending suggestion points at a
  since-hidden category. Unfreezing is a product change, not a flag.
- The job never writes `transactions.category_id`; accepting stays the
  normal transaction update path.
- Retry policy is in the chunk activity: `timeout` is retried ONCE for that
  transaction (a timed-out generation may already be billed) and then counted
  failed; `bad_response` counts the transaction failed; a cut-off answer
  (`stop_reason: max_tokens` / `finish_reason: length`, its own `truncated`
  kind) is counted failed and recorded, so it is retried only after the
  attempt backoff, never blindly; a request-scoped 4xx (400/413/422) is
  counted failed; after `CATEGORIZE_MAX_CONSECUTIVE_REQUEST_FAILURES = 3` in a
  row the run stops with a non-retryable `AiSystematic` failure and the fixed
  sentence "The AI provider rejected the requests; the run stopped. Check
  your AI settings and try again." — a request-shape bug must not end as a
  "successful" run where every transaction failed. A transaction that spends
  its token cap is counted failed. Account/key-level 4xx (402, 403,
  404 …), `auth` and `transient` stop/retry the run as before: `auth` and
  `permanent` are non-retryable ApplicationFailures, `transient` retries the
  activity. `rate_limited` waits once inside the chunk (up to 60 s) and
  retries the ONE transaction; a second 429 returns to Temporal, which waits
  the provider's retry-after (capped 15 m). Doc basis for the 400/413/422
  split: Anthropic `invalid_request_error` = "an issue with the format or
  content of your request" and `request_too_large` = 413
  (platform.claude.com/docs/en/api/errors); OpenAI 400 `invalid_request_error`
  (developers.openai.com/api/docs/guides/error-codes). Neither status means
  the key or account is wrong.
- Cost caps and their consistency: `CLASSIFY_MAX_TOKENS = 4000` per turn
  (reasoning tokens count toward the cap on current Anthropic models and
  OpenAI reasoning models, so a 1k cap could be spent thinking before the
  answer; `ai/http.ts` derives 160 s from 4000 at its conservative 25
  tokens/s), at most 6 calls per transaction (4 tool turns + final answer +
  one timeout retry) and 80k tokens (input+output) per transaction
  (`>= 6 x 4000` plus ~9k input per call with capped tool results),
  `CATEGORIZE_CHUNK_SIZE = 5`, `CATEGORIZE_RUN_LIMIT = 100` transactions per
  run (the remainder waits for the next run; coalescing means the next
  trigger starts a new run), `CATEGORIZE_CHUNK_TIMEOUT_MS = 5 x 6 x 160 s +
  60 s = 81 min`, which is the chunk activity's `startToCloseTimeout`; a test
  asserts the formula and the 4000-token deadline. Worst case one run: 600
  calls (100 x 6) for the transactions, plus activity retries: each chunk has
  up to 5 attempts, a retry resumes after its last finished transaction, so it
  re-asks only its in-flight transaction (up to 4 x 20 chunks x 6 = 480 extra
  calls; hard ceiling ~1,080 calls). Token budgets: 100 x 80k = 8M for the
  transactions, plus the in-flight transaction's budget per retried attempt —
  the caps, not the expected usage; a typical transaction is one call and the
  per-run trigger is coalesced to one run.
- Reasoning effort is an optional AI-port field (`AiReasoningEffort`), mapped
  by each adapter to the provider's documented parameter and omitted where the
  provider/model documents none. The categorizer asks for `low` on every
  call. Doc basis (documentation only, no live call was made): Anthropic
  `output_config.effort` (platform.claude.com/docs/en/build-with-claude/effort,
  applied to Opus 4.5+, Sonnet 4.6+, Haiku 5.5+, Fable/Mythos 5+); OpenAI
  `reasoning_effort` (developers.openai.com/api/docs/guides/reasoning,
  gpt-5+ and o-series only); OpenRouter `reasoning: {effort}`
  (openrouter.ai/docs/guides/reasoning-tokens); DeepSeek `reasoning_effort`
  (api-docs.deepseek.com/guides/thinking_mode); Z.ai `reasoning_effort` on
  GLM-5.3 (docs.z.ai/guides/llm/glm-5.3). `AiChatResult.finishReason` is the
  provider's raw stop reason. These mappings are unverified against a live
  provider; adapter tests assert the request shape the docs describe.
- Untrusted text is bounded before it can reach a prompt: every bank string,
  payee, memo and category note is capped at 200 characters (names at 80 in
  tool results), `list_categories` is at most 200 categories and drops its
  notes before a result may exceed `MAX_TOOL_RESULT_CHARS = 40k`, and the
  other tools cap their rows. Free bank text (`descriptionRaw`, the PIX
  `reason`) is masked first: formatted/bare CPF and CNPJ runs and 6+ digit
  account/reference runs become `***`; the structured `merchant.cnpj` is kept
  (merchant panel, business evidence). The cap runs on the masked text. Provider calls are serialized per key in-process
  (`categorize/key-lock.ts`) and the `-ai` queue runs one activity per worker
  (`maxConcurrentActivityTaskExecutions: 1`); across pods the provider 429 is
  the bound. The chunk heartbeats its progress (counts, cursor, token totals)
  every 10 s and on every transaction/call, and a retried attempt resumes
  after its last finished transaction with those totals — finished rows are
  never paid for twice, and a stopped chunk's tokens still reach the ledger.
- Continue-as-new is deliberately NOT implemented yet (FU10): with the
  100-transaction cap a run is at most 20 chunks (~60 history events), far
  from Temporal's 50k event hard limit. If the cap or chunk count grows,
  carry the summary and cursor into a continuation.
- Known, deferred (review FU6/FU7): Temporal throttles heartbeats (~80% of
  the 30 s heartbeat timeout), so after a worker crash the resumed
  `examined`/cursor can lag 1–2 transactions; a finished row is skipped again
  by the suggestions/attempts filters, and a forced run can re-bill the lag
  window. The chunk deadline has ~60 s of slack (the in-chunk 429 wait is
  per transaction, DB/key-lock/connect time is unbudgeted); a start-to-close
  timeout resumes from the heartbeat, so the impact is bounded. Fix both if
  the caps or chunk size grow.
- The final structured-output turn keeps the tools declared because the
  history contains tool_use/tool_result blocks: Anthropic's tool-use doc says
  "Send the request with the same `tools` as the first request" and
  "tool_use ids were found without tool_result blocks" is its documented 400
  (platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls).
  Anthropic then gets `tool_choice: {"type":"none"}` (define-tools doc);
  OpenAI/OpenRouter/DeepSeek get `tool_choice: "none"` (OpenAI function
  calling guide), and Z.ai — whose OpenAPI documents only `"auto"` — keeps
  the tools without a choice. Adapter tests stub the documented rejection.
- No usable key (or a key without a model) ends the run at once as a
  succeeded run with a fixed user-safe sentence in `job_runs.user_message`,
  like the connections "paused" notice — not a failed run with retries.
- The key is resolved inside each activity and never crosses workflow
  history; activity results carry counts, ids and the cursor only; failures
  use fixed sentences, so no provider text (and no key) reaches
  `job_runs`, `job_attempts`, `job_logs` or the workflow. Unexpected
  failures log only their Postgres error code for diagnosis. Because no
  provider error text is kept, `redactSecrets` has nothing to redact. The
  registry swap (`setProviders`) is a deep-import test seam, not part of the
  AI barrel: it hands the decrypted key to its caller.
- Whose key a run spends is ONE function, `store.runActorForBudget`: the
  budget OWNER's key (own, else the shared AI key when the owner has the
  feature), whoever starts the run, and the ledger tenant is that owner.
  `startCategorizeRun` does not take an owner from its caller. This is a
  confirmed product decision: a member of a shared budget triggering a run
  spends the owner's key; changing it is a change to this one function.
- `readCategorySuggestions` is scoped by budget id only; the HTTP layer
  checks budget access. A non-uuid `transactionId` is a 400
  (`invalid_transaction_id`), not a driver error. `readCategorizeAttempts`
  reads `categorize_attempts` per transaction (same scope, same uuid check);
  see the attempts bullet above for the queue's "not classified" vs
  "classified, none" distinction.
- Migration 0111 adds `category_suggestions(category_id)`: the FK is
  `on delete cascade`, so a category delete would otherwise scan the table
  per row. The 0110/0111 foreign keys into `transactions`, `budgets` and
  `categories` add no new constraint on the shared database: syscd-app has
  no TRUNCATE of those tables (checked with ripgrep; its only TRUNCATE is
  `food_portion, food_catalog ... cascade`), and `transactions` already had
  referencing tables (`subtransactions`, `connection_transactions`,
  `transfer_links`), so a plain `TRUNCATE transactions` was never possible.
- `AiChatResult.usage` was added to the AI port (OpenAI-compatible
  `prompt_tokens`/`completion_tokens`, Anthropic `input_tokens`/`output_tokens`;
  null when the provider reports none). The run result and each chunk log
  line report input/output token totals; nothing estimates them.
- One run per budget: subject key = budget id, so every trigger joins the
  active run. Provider calls run on the `<queue>-ai` task queue (1 activity
  start/s across pods, one activity at a time per worker), separate from
  ledger and bank work.

## Transfer payee lifecycle (budget-upgg, transfers T2)

Plan: `.agents/plans/2026-11-24_transfers-refactor.md` (T2). Code:
`api/src/budget/domain/transfer-payees.ts` (lifecycle, protection, text
resolution), `edited-payee.ts` (the payee of an edit), `transfer-payee-repair.ts`
(plan, report, repair), `store/transfer-payees.ts` (SQL),
`scripts/repair-transfer-payees.ts`.

- Every account has exactly one system payee "Transfer : <account>", found by
  id: `payees.transfer_account_id` and `accounts.transfer_payee_id` are set
  together when the payee is created.
- Created with the account in every path that makes accounts: `POST /accounts`,
  restore (a transfer leg takes the PEER account's payee by account id), budget
  copy (an account the copy left without one gets one). Renamed in the same
  transaction as the account (`renameTransferPayee`: same payee id, new name).
  Kept when the account is closed. Retired when the account is deleted; the
  retired payee's name gets a "(deleted <id>)" tail so a new account of that name
  can have its own.
- Names are unique per budget, so a second account with the same name gets
  "Transfer : X (2)", the third "(3)". Whether two accounts may share a name is
  an open owner question; the numbering stays until it is answered.
- **Ordinary requests never repair.** `ensureTransferPayee` uses what exists
  without writing (the account's pointer, else the payee that points at the
  account). It writes only to CREATE a payee when there is none (and set the
  account's pointer), or to adopt a LIVE payee nobody links to whose name is
  exactly the account's (set its `transfer_account_id`, and the pointer). It does
  not un-hide, un-delete, re-point, merge or insert a numbered payee to work
  around bad data. Renaming an account renames its own payee and nothing else:
  a name held by any other payee (another account's, an ordinary one, a
  leftover) is skipped, the payee takes the next numbered name, and the
  collision is logged (`[transfer-payee] account ...`) for the repair; a
  concurrent insert of the wanted name is retried with the next name
  (savepoint). Fresh start copies duplicates as they are and logs the report
  (`[transfer-payee] fresh start ...`); it deletes and merges nothing.
- **Only the repair merges and deletes.** `repairTransferPayees` and
  `scripts/repair-transfer-payees.ts` (report first, `--apply` in one
  transaction, idempotent). Folding a duplicate moves its transactions, splits,
  scheduled rows, repeat rules, locations and `transfer_links.prev_payee_id`
  within the budget; its renaming and "treat as transfer" rules move when the
  kept payee has none, otherwise they are lost and the report lists each one
  (`dropped_rules`). A duplicate that rows of ANOTHER budget reference is not
  deleted (the foreign keys would null those rows): it is unlinked and kept, and
  the report lists it in `kept_payees` ("referenced from another budget", see
  `docs/runbooks/transfer-payee-cross-budget.md`). A numbered name is normalised
  to the plain one once nothing else holds it.
- Uniqueness is kept by code, not by an index: the shared database's other app
  also writes `payees`. Migration 0117 only adds a plain partial index on
  `payees(transfer_account_id)`. It is not built CONCURRENTLY: the migration
  runner runs every file inside a transaction, where that is not allowed; the
  build briefly blocks writes to `payees`, which is small.
- The payee endpoints refuse to rename, merge (source or target), delete or
  hide a transfer payee: 409 `transfer_payee_protected` with `params.name`.
  Showing a hidden one, renaming rules, categorization and the "treat as
  transfer" rule stay allowed.
- `GET /payees` lists transfer payees only with `include_transfers=true`, each
  with `transfer_account_id` and the additive `transfer_account_name`. Default
  off because every current client caller would show them as ordinary payees.
- **Payee text is still accepted, and one resolver reads it everywhere** (register
  create/edit, repeat rules, statement import, bank sync), in this order:
  (1) the exact name of a LINKED transfer payee ("Transfer : X", "Transfer : X
  (2)") means that payee's account; (2) text produced by a renaming rule whose
  target is a live payee nobody links stays that ordinary payee (no transfer);
  (3) "Transfer : <name>" means the live account called <name>, the newest when
  several share it (a text that is no payee's name); (4) no match is an ordinary
  payee. So with two accounts named X, "Transfer : X" is the one holding that
  payee name (the older), "Transfer : X (2)" the second; payee_id reaches either.
  Duplicate and make-repeat, which re-send the stored name, keep the peer.
- **`payee_id` (additive, optional) on transaction create and update** wins over
  the text (null = no payee); a payee outside the budget is 400
  `payee_not_in_budget`. New clients send it.
- **Edits never read stale text as a change** (the released client re-sends the
  payee text on every edit, duplicate and make-repeat): text equal to the name of
  the row's current "Transfer : ..." payee is unchanged; on a row that is
  already a transfer, a "Transfer : ..." text naming no account, or the row's
  current peer, is unchanged; only text naming a different live account, or an
  ordinary payee, changes it. Text equal to a FORMER name of the row's current
  transfer payee is unchanged too, even when a new account holds that name now:
  `renameTransferPayee` records the old name in `transfer_payee_former_names`
  (migration 0118, same transaction), because the released client re-sends the
  cached text and the server cannot tell it from a deliberate pick otherwise. On
  create the same text means the account that holds the name now. A duplicate or make-repeat sent with a stale text creates an
  ordinary row (no mirror). A non-transfer row whose stored payee is a legacy
  "Transfer : X" cannot be turned into a transfer by re-picking that same text.

## Two open accounts never share a name (2026-11-25)

Creating or renaming an account to the name of another OPEN account of the
budget (case-, edge- and space-run-insensitive) is `409 account_name_exists`
(`params.name` = the holder's name); reopening a closed account into such a
name is refused the same way. Closed and deleted accounts do not block. Existing
duplicates are grandfathered: editing their other fields, re-sending the same
name, closing them, restore and fresh start (raw SQL copies) all keep working;
the transfer-payee repair script reports them. No unique index (the database is
shared with another app): the check runs in the write's transaction after a
`FOR NO KEY UPDATE` row lock on the budget, which serializes account-name writes
of one budget and does not block the FK checks of other inserts. Bank linking
(`PATCH /accounts/:id` with `link`) never creates or renames an account.
||||||| 5e847a6

## Transfer integrity on the server (budget-nq2f, transfers T3)

Plan: `.agents/plans/2026-11-24_transfers-refactor.md` (T3). Model: a transaction
is a transfer when its payee is an account's system transfer payee; between two
on-budget accounts it is ONE linked pair (both `transfer_account_id` and
`transfer_transaction_id` on both legs, each leg's payee the peer account's
transfer payee) with no category. Schema (additive): migration 0119 adds the table
`transfer_hints`, 0120 the nullable column `transfer_marks.released`.
Rule of the review round: a row that is correct as main stores it does not change
on a sync, an ordinary request or a budget copy.

- **A leg leaving a pair never deletes a bank row (R1).** Editing the payee of one
  leg to an ordinary payee, moving it to another peer, or deleting it takes the
  other leg out of the pair through `removeMirror` (domain/transfers.ts): an
  IMPORTED mirror (import id set) that the matcher or a person linked (a
  `transfer_links` record, `created_mirror = false`) is RESTORED as
  `POST /transfers/unlink` does (previous payee and category, shadow unblocked
  when it was not blocked before, mark `manual`: suggested, never re-linked on
  its own); an imported row without a record gets the ordinary payee its import
  name stands for; a row without import id (hand-made mirror, or the user's own
  row that was linked) is soft-deleted with its balance reversed, as on main. The
  bank id stays live, so later syncs neither skip nor duplicate it. The release is
  recorded in `transfer_marks.released` (which leg released the row, and the row's
  fields at that moment); any later write of the mark (an unlink, "not a transfer",
  a link) clears it. When THAT leg's payee is set back to the transfer of the same
  account, exactly that row is linked again (same account, opposite amount,
  still unlinked, uncategorized, and unchanged since the release: payee, date,
  memo, flag, approval, cleared state) instead of adding a second mirror next to it;
  in every other case a mirror is created as on main, and no mark or payee of a row
  the user did not choose is touched. A link record on both legs lets unlink work.
- **A hand-entered transfer plus a later bank import of the other side still
  yields two rows, as on main (R2 is NOT fixed here).** The matcher ignores rows
  that already carry pointers, so the hand-made mirror and the bank row both stay
  and the account counts the money twice until the person deletes one. An
  automatic replacement was tried and cut: it ignored decisions, adopted unrelated
  same-amount rows over the whole history and merged the user's fields into a bank
  row. A suggestion-based fix (offer the pair, let the person confirm, undo-able)
  is a separate task (budget-kzof).
  The same holds when a re-link is refused (the released bank row was edited, or
  its leg was deleted): the peer account then has the released bank row plus a new
  mirror, two rows for one movement, as with a hand-entered transfer; budget-kzof
  will offer the merge as a suggestion.
- **Imports never store a transfer payee without the transfer (item 6).** A NEW
  statement-import or bank-sync row whose payee text (after the renaming rules)
  means "Transfer : <account>" is not given that payee: it would be a payee-only
  half transfer, and a mirror created from an import would duplicate the money
  when the other side arrives from the other bank. It stays an ordinary
  uncategorized row with the ordinary payee of its raw text (none when the raw text
  is itself a transfer payee's name; the bank text stays in `import_payee_name`),
  and the account goes to `transfer_hints`. The matcher treats a hinted row as
  STRONG evidence for THAT account (it pairs only with a row of it; the bank rules
  still refuse the same pairs; the bank's own contradicting category ("against")
  stays a veto; alone it is a one-side suggestion). The hint ends
  when the row is linked, gets a category, gets another payee, or is marked "not a
  transfer"/"outside"; a refreshed row keeps or loses it with its text. **Rows an
  earlier sync stored with the transfer payee are not touched:** the sync compares
  the bank text in both forms it has been stored in, so such a row stays
  "unchanged" and, when the bank corrects its amount or date, keeps its payee.
  Statement-import ids keep counting under the id main used (the account's own
  pointer when it has one, even a wrong one), so re-importing a file stays
  idempotent; the ordinary payee of the raw text is created only for rows that are
  inserted (an all-duplicate re-import creates no payee, as the sync). A row the
  sync changes takes payee, shadow name, import name and hint from ONE resolution,
  so row and shadow always agree. The register still creates the mirror.
- **Complete transfers.** Repeat rules: occurrences behave as on main (a pending
  occurrence is one row: no mirror, no pointers, no engine or balance effect, Make
  Repeating unchanged). When an occurrence becomes a REAL transaction (the date
  passes in `generateDueOccurrences`, or an edit detaches it) and its payee is an
  account's transfer payee, the pair is written: both pointers, the mirror with
  the peer's payee, no category between two on-budget accounts, the mirror's
  balance applied; a payee whose account cannot receive it (own, closed, deleted)
  stays as it is. A restore writes both pointers and no category on legs. A
  **budget copy is as on main** (rows copied as they are, unlinked accounts start
  at 0, no leg is copied into accounts that are not carried over, no balance
  changes); the half-linked rows it leaves are listed by the repair.
- **Rows already half-linked are reported, never rewritten on read.** The transfer
  payee repair (`scripts/repair-transfer-payees.ts`, report first, `--apply`,
  idempotent, one budget) lists and repairs them (`half_linked`;
  domain/transfer-link-repair.ts): a mutual pair missing the account pointer, a
  payee-less leg or a category on an on-budget pair is completed; a leg known only
  by its account pointer or only by its transfer payee is paired with the one row
  that is its other side (same day for the account pointer, within 3 days for a
  payee-only leg), no balance moves, a record on both legs so unlink works; a leg with no other side
  (`needs_mirror`) or several (`ambiguous`) is only reported;
  `--apply --create-mirrors` creates the missing mirrors (it moves the peer
  account's balance: only after reading the report).
- **No category on a leg of an on-budget pair, on every write path.** Create, edit
  (also Categorize accept), link, restore, flip of an occurrence, repair; a leg to
  an off-budget account keeps its category. A "leg" is a row with a transfer
  pointer to an on-budget peer: a payee-only row from main (no pointers) is not
  touched by an unrelated edit. The server reads a category on such rows only to
  display it (payee transaction list, backup export, Categorize's read of a row
  already excluded from its queue) and for the payee's "most used category"
  suggestion; no budget math, report or MCP output depends on it (the engine is
  client-side and already ignored it).
- **Payee lifecycle carry-overs.** The repair's absorb records the folded payee's
  name and former names on the kept payee, and clears the folded payee's "treat as
  transfer" rule after moving it (or listing it in `dropped_rules`). A transfer row
  edited to text a renaming rule turns into an ORDINARY payee's name stops being a
  transfer. `ensureTransferPayee` writes only what was agreed (create a missing
  payee; adopt an exactly-named unlinked one): a pointer at ANOTHER account's payee
  is ignored for the request (the account's own linked payee is used, else one is
  created WITHOUT touching the pointer) and left to the repair. Deleting an account
  retires the payees that point at it, never another account's.

## Renaming rules assign the payee (budget-mkrt, transfers T3b)

- **A matching rule assigns its payee, whole.** "Imported payees that <is |
  contains | starts with | ends with> X are renamed to this payee": a matching
  text is stored with THAT payee (by id), and the imported text is the row's
  import name (`import_payee_name` and `_original`, also for bank sync, where it
  used to be the rewritten name). Before, a `contains` rule rewrote only the
  matching part ("PIX SAVINGS 42" with contains "PIX SAVINGS" became the ordinary
  payee "Transfer : X 42", "PADOCA 42" became "Padaria 42"). The same on register
  create, repeat rules, POST /payees (a name a rule matches returns the rule's
  payee), statement import and bank sync.
- **A rule of a transfer payee.** A payee that is an account's transfer payee holds
  rules too. A register entry (or a repeat rule) a rule assigns to it makes the
  transfer with its mirror, as typing the payee does. A row an IMPORT or bank sync
  assigns to it stays an ordinary uncategorized row of the text, with a transfer
  hint for that account (no mirror, no payee-only half transfer; the matcher links
  it with the other bank's row, once). A rule of a transfer payee whose account is
  gone never fires.
- **Several rules per payee: `payee_renaming_rules` (0121).** Additive: id, budget,
  payee, `match_type` (`is`, `contains`, `starts_with`, `ends_with`), `condition`,
  `created_at`; one exact (budget, match type, pattern) per budget (the only index).
  The migration copies each live payee's single rule AS IT IS (not trimmed, not
  case-folded), oldest payee first, only for payees with no row in the table yet, so a
  re-run changes nothing and never brings a removed rule back, and it drops nothing:
  patterns that differ only by case or by spacing stay two rules, the older fires first
  (as on main). The add / update operations refuse a rule another rule already says
  (same match type, same pattern ignoring case: 409 `rename_rule_exists` naming the
  holder); a pattern of 1 character is refused for contains / starts / ends (400; stored
  ones keep working; `is` may be 1).
- **The old columns are an input, and a mirror.** `payees.rename_match_type` /
  `rename_condition` (0016) are NOT dropped: the database is shared with syscd-app and
  the released client's single-rule call writes them. A rule found there that the table
  does not have (same payee and match type and pattern ignoring case) is read as a rule
  of the payee for matching, shown by the payee list and the rule list (which make it a
  row), and made a row before ANY rule write of that payee (add, update, remove, the
  single-rule call, merge, repair), so the mirror never erases it. Every rule write then
  mirrors the payee's first "is" / "contains" rule into the columns (null without one;
  left empty rather than failing when another payee's column already holds the same
  text). The columns are an input ONLY while the payee has no is/contains rule in the
  table: once this app holds one for the payee, the table is the truth and the columns
  follow it. So a rule the other app writes for a payee without one applies; a replace
  or a clear done there afterwards does not take effect (the table keeps its rule, and
  the next rule write here restores the column). There is no two-way sync: rules are
  edited here. Reads (the payee list, the rule list, matching) include a column-only rule
  computed at read time and write nothing; its id is the one it gets when it becomes a
  row (the next rule write of that payee). Released
  clients keep working: `budget_payees_set_rename_rule` (PUT /payees/:id/rename-rule,
  same input and output) sets, changes or, with an empty condition, removes that first
  rule and leaves the others; the payee list keeps `rename_match_type` /
  `rename_condition` (never a "starts with" rule, which the released enums do not know)
  and gains `rename_rules` (every rule). New operations:
  `budget_payees_rename_rules_list` (GET /payees/:id/rename-rules), `_add` (POST),
  `_update` (PUT /payees/:id/rename-rules/:rule_id), `_remove` (DELETE ...). `created_at`
  is ISO UTC with milliseconds everywhere. Deleting a payee removes its rules; merging
  moves them to the target (the text keeps resolving to the rows' payee); the repair
  moves them all (`rename_rules_dropped` stays 0, `dropped_rules` lists only "treat as
  transfer" rules); a fresh-start copy copies them. A rule of the transfer payee of a
  closed or deleted account never fires.
- **POST /payees is not an import.** A payee created by name is created (or found) by
  exactly that name: no renaming rule applies (main spliced the rule's payee into the
  name; that was dropped, as it produced names like "Padaria 5"). The 2-character
  minimum applies only to the new rule operations (400 `rename_rule_too_short`); the
  released client's single-rule call still accepts 1 character, as on main.
- **Matching is main's comparison, nothing more.** Both the pattern and the text are
  compared after `toLowerCase()` and nothing else (`normalizeRuleText`, the one function
  the matcher and the frozen earlier matcher share): no trimming, no collapsing of
  repeated spaces, no accent folding ("pão" is not "pao"). The callers trim the TEXT
  (bank sync, statement import) and the contract trims a pattern when it is written, as
  before; a text with two spaces matches only a pattern with the same two spaces. When
  several rules match one text (of one payee or of several): the most specific first
  (`is`, then `starts with` = `ends with`, then `contains`), then the longest pattern, then
  the oldest rule: the rule's own `created_at`, then its creation sequence `seq` (the
  copy numbers rules by payee age, then physical order; a pending column rule comes
  last), then id. That is deterministic for NEW rows whatever the payees' `created_at`
  (a fresh-start copy gives every payee one). A blank pattern never matches. The
  recognition of rows main stored does NOT depend on this order: main took the first rule
  among equals in whatever order Postgres returned them, so a stored row is recognised if
  it holds the splice (name, and import key) of ANY matching is/contains rule.
- **Rows already imported keep their payee, import key and dedupe.** Main's behaviour
  is kept, frozen, in `domain/legacy-rename.ts` and used only to READ what earlier
  imports stored. Bank sync: a row whose payee is what the earlier behaviour stored for
  the same text (`earlierNames`, also when that was the text itself) is unchanged, never
  rewritten for that alone; a row whose bank text changes, or a new row, takes the new
  assignment (a rule added or changed later does not re-apply to stored rows: see "Rules
  apply going forward" below). Statement import: the import id keeps
  counting under what it always did (the account's transfer payee for text that names an
  account, otherwise the ordinary payee's id, now the assigned payee's id for a rule hit);
  the keys the earlier behaviour counted under are also looked up (read only; the payee a
  new key names is created only for a row that is inserted), so a file imported before is
  still all duplicates and creates no payee. Proven by
  `connections/rename-rules-legacy.test.ts` against rows recorded by running main
  (`testdata/main-rename-capture.json`: double spaces in bank text and in patterns, patterns
  differing only by case or spacing, overlapping rules, rules on transfer payees, rows the
  person edited, client-style statement rows), both through the migration and straight
  from the columns.
- **A payee the person chose is not a bank text.** The released client's statement
  import sends the chosen payee's NAME as `payee` and the parsed statement text as
  `import_payee_name_original`. Main ran every `payee` through the rules and could not
  tell them apart; /bulk now treats a row whose `import_payee_name_original` differs from
  `payee` as a chosen payee: no rule applies to it (it is found or created by name), while
  the statement text still is assigned. A /bulk row counts its occurrences per key prefix
  (amount, date, payee id) as main did, so two texts a rule sends to one payee on one day
  for one amount are two rows. Inside a key, a stored row is a re-import of an incoming one
  only when the PAYEE FIELD it was imported under is the incoming one, case ignored (the
  field main keyed on: `import_payee_name`, falling back to `import_payee_name_original`
  for old rows). For a plain statement row that is the bank text, so two rides (two texts)
  are two rows; for a client row it is the chosen or associated payee's name, so the same
  transaction whose bank text changed (pending, posted) with the same chosen payee is one
  row, and a stored YNAB-export row whose raw text differs from the file's still dedupes,
  both as on main. A text the key has not seen is NEW and takes the next free occurrence
  number of the key: the second ride arriving in a later, overlapping file is imported, as
  on main (where its text made its own key). Within one text main's rule is kept
  (`existing <= occurrence`: any stored row of the text makes every copy a duplicate), so
  more copies of the same text in a later file are still not imported. Deleting: deleting
  the ONLY row of a text means the next re-import re-creates it (as on main); deleting one
  of several identical rows does not re-create it (main re-created it or not depending on
  which copy was deleted: an intended improvement). A stored row with no payee field on
  record counts for any text, by its number, as before.
- **Editing a row never moves its payee by rule.** The released clients resend the displayed
  payee text on every edit; a text equal to the row's current payee name, case ignored (ordinary or
  transfer payee) means the payee is unchanged, before any rule runs, so a memo or category
  edit of "Taxi 9" (stored by an earlier import, rule contains TAXI -> "Taxi") keeps "Taxi 9".
  CREATE applies the rules to the text, as on main, now by assignment: a typed or duplicated
  "Taxi 9" becomes the payee "Taxi" (main kept "Taxi 9"). Make repeating from the register
  attaches the row and takes its payee id; the resent text is not resolved. A repeat rule
  created from typed text resolves it like a create.
- **The matcher sees an assigned row as untouched.** `untouched_ledger` (candidate
  loader) also accepts a payee equal to the sync shadow's last payee, and a statement row
  (no shadow) whose payee is one a rule of that payee assigns for the imported text, by
  main's own test: a `contains` rule counts when the text with the pattern replaced by the
  payee's name equals the text (main's spliced name), an `is` rule when the name equals it,
  a `starts with` / `ends with` rule always (they never existed on main). The rules read
  are the same source as matching, column-only rules included. Only statement rows get this
  (no sync shadow, and an import key that is not a bank provider's `<provider>:<id>`, so a
  statement file's own ids such as `nubank:...` count): a carried bank row without its shadow (a fresh-start copy
  does not carry `connection_transactions`) keeps main's answer, so a carried row the person
  edited stays touched. A rule-assigned row is therefore untouched exactly where main's was,
  and the hinted text rows of T3 stay untouched.
- **Editing a rule re-points rows imported under it.** Superseded by "Rules apply going
  forward" (budget-ou8p), below: it no longer does.
- **Carry-overs of review nq2f round 4.** F-a: a /bulk text naming an account whose
  pointer names another account's payee no longer stores an ordinary payee called
  "Transfer : <account>" (the account gets its linked payee, the key stays the
  pointer). F-b: a statement payee is created after its row is inserted, so a
  duplicate row with its own import id creates none. F-c: re-linking a leg whose
  previous payee was a transfer payee records the ordinary payee its import text
  stands for, so unlinking does not leave it without one. F-d: a hint naming a
  soft-deleted account is ignored by the matcher.

## Rules apply going forward (budget-ou8p)

Owner decision (2026-11-25): "No by default, with an Apply to past transactions button on the
rule". Adding, changing or removing a renaming rule never changes the payee, the import key
or the dedupe of a transaction that is already stored, by itself. Only rows INSERTED
afterwards (bank sync, statement import, register, repeat rules) take the rule.
No data is rewritten and there is no migration: "stored before the rule" is decided from the
row, not from a timestamp.

- **Bank sync never re-resolves a row whose bank TEXT did not change.** For an untouched synced
  row (shadow not blocked, still equal to the shadow), "the bank changed the text" is decided
  by comparing the TEXT, never the provider object (which differs from pull to pull in balance,
  status, updatedAt). The stored text is, in order: the text read out of the previous pull's
  stored object by `rawBankText` (`connections/bank-text.ts`: `typeof raw.description ===
  'string'`, trimmed: the expression the adapter resolves `description` with; a test proves they
  agree), else the text the sync recorded (`connection_transactions.bank_text`, 0122), else the
  row's `import_payee_name` when it
  equals the bank text (every row stored since a rule assigns its payee). When none of these
  says (rows older than raw storage, rows of the earlier behaviour, whose import name is the
  REWRITTEN name, with a stored object that lacks the text) nothing is known about the past
  text and the text counts as UNCHANGED: the row is never re-resolved merely for that, and the
  first pull records the text. `bank_text` is written on EVERY pull that sees the row (insert,
  refresh and duplicate alike), in the same statement that stores that pull's provider object, so
  it always equals the text of the latest pull: a text change that keeps the payee ("UBER *TRIP
  PENDING" to "UBER *TRIP" under `contains UBER`) is recorded when it happens and a later rule
  edit or add re-points nothing. Text unchanged and date and amount the same: duplicate (no
  peek, no payee, whatever the rules say now). Text unchanged, date or amount moved: the row
  follows the bank and keeps its payee, import name, hint and shadow payee, for rows of every
  form (also those of the earlier behaviour: a legacy row never re-points because the bank
  moved its amount). Only a row whose text demonstrably changed, and a new row, is resolved
  with the current rules. The recognition of earlier-behaviour forms (`earlierNames`,
  `legacyName`) is unchanged for those. Limitation: a text the bank changed BEFORE the first
  pull that records it cannot be seen (nothing was stored to compare with).
- **/bulk recognises a stored row by what it was imported as, under any key.** The key is
  `YNAB:<milli>:<date>:<payee id>:<occurrence>`; a rule changes the payee id a text resolves
  to. An id-less row is a re-import when a stored row of the account has the same signed
  amount, the same date and the same statement text, under any key, whatever payee id its key
  names. The text is compared TRIMMED AND EXACT here (another case or spacing is another text:
  "Coffee Shop" then "COFFEE SHOP" on one day for one amount import both, as they did on main,
  where they were two keys); within one key the earlier lower-cased comparison stays. The earlier
  per-key lookups (current key, earlier keys, rows with no text on record) stay, and a new text
  still takes the next free occurrence of ITS key. A second transaction with the same date,
  amount and text arriving in a LATER file is still a re-import and is dropped, exactly as on
  main (a stored row of that text makes every copy a duplicate; only copies inside one file
  count). Side effect, an improvement over main: a stored row whose key payee was merged or
  deleted since is still recognised. No payee is created for a duplicate.
- **Apply to past transactions: three operations, none exposed to MCP** (API and CLI only, like
  other bulk actions). `budget_payees_rename_rules_apply_preview`
  (GET /payees/:id/rename-rules/:rule_id/apply-preview, a read), `budget_payees_rename_rules_apply`
  (POST .../apply) and `budget_payees_rename_rules_revert` (POST /payees/rename-rules-revert, body
  `{ budget_id, apply_id }`). Preview and apply run the same selection (`domain/rename-apply.ts
  planRuleApply`); apply runs it inside its database transaction with the candidate rows locked,
  so it changes exactly the rows a preview taken at that moment counts. One budget revision bump
  (the existing deferred trigger dedupes per transaction). Apply does NOT run the transfer matcher:
  the hints it writes are picked up at the next sync or transfer review.
- **Which rows.** Live, bank-imported (`import_id` set) rows of open accounts whose REAL bank
  text the rule WINS under the normal matching order (most specific, longest, oldest; a rule of
  a dead transfer payee never fires). The real text of a synced row is the stored provider
  object's (`rawBankText`), else the one the sync recorded; of a statement row, its import
  text (`import_payee_name_original`, else `import_payee_name`). Never a synced row's import
  name: rows of the earlier behaviour hold the rewritten name there, and matching it would change
  rows the rule does not hold (the next sync would undo it). A synced row whose text is not known
  is skipped and counted in `skipped.unknown_text` (the next sync records it, then it is
  eligible). The preview sample shows this real text.
- **Skip counts are one judgement.** A matching row is skipped, counted by the first reason of:
  reconciled; transfer already (linked, pointing at an account, or holding a transfer payee);
  edited; unknown_text; bank_rules. "Edited" means NOT PROVABLY AS IMPORTED, the same test for
  every row: the transfer matcher's `untouched_ledger` (store/transfers.ts, `UNTOUCHED_LEDGER_SQL`,
  shared, not copied: payee null, or equal to the import text, or to the sync shadow's payee, or,
  for a statement row, the payee a rule of that payee assigns for the text), plus, for a synced
  row, an unblocked shadow that still equals the row (date, amount, memo, payee), plus: a payee
  chosen in an import screen is the person's. Conservative: a statement row whose assigning rule
  was removed since no longer proves it and counts as edited (never the other way). Categories are
  never written. Rows keep `import_id` and the import names.
- **What it writes.** The payee (`transactions.payee_id`), the sync shadow's payee for a
  synced row (so the next sync sees an unedited row), and transfer hints. Ordinary payee
  rule: the row gets the rule's payee and loses any transfer hint. Rule on an account's transfer
  payee: as an import does, the row keeps (or gets, created if missing) the ordinary payee of its
  text and a `transfer_hints` row for that account (not for a categorized row or a row of that
  account itself); never the transfer payee, never a mirror row, no `linkTransfers` run. A row the
  matcher's bank rules would never pair with the hinted account (`pairViolation`, the row's side
  by amount sign: card outflow, cash to a card at another bank, checking to checking at one bank)
  is skipped entirely and counted in `skipped.bank_rules`.
- **Revert is recorded on the server and takes only an id.** Every apply writes a record
  (`rename_rule_applies`: id, budget, rule, user, time, reverted_at; `rename_rule_apply_rows`: per
  changed row the previous and the new payee and hint; migration 0122) and returns its
  `apply_id`. Revert reads that record only: nothing the caller sends names a row, a payee or an
  account (a body of rows is refused), the id is scoped by budget (another budget's id is a 404).
  In one transaction it restores a row only while the row is exactly what the apply left (same
  payee and hint; a synced row's shadow unblocked and still saying that payee), still live in an
  open account, not reconciled, linked or a transfer; the payee put back must be a live ORDINARY
  payee and a hint a live open account other than the row's own. Everything else is left as it is
  and reported (`changed_since`, `payee_gone`, `not_found`). Only the payee, the hint and the
  shadow's payee are put back: a category, memo, approval or amount changed after the apply stays
  as the person left it. An apply is reverted ONCE: `reverted_at` is set, and a second revert
  restores nothing (`already_reverted`) even when a later apply touched the same rows (apply1,
  revert1, apply2, revert1 again: nothing; revert2 restores).
- **Locks.** One per-budget advisory lock (`lockBudgetImportWrites`, `pg_advisory_xact_lock` on a
  hash of the budget id) orders the bank sync against an apply or a revert. The sync takes it
  SHARED (`pg_advisory_xact_lock_shared`) for the budgets of the accounts it pulled, in id order,
  right after it locks its connection row and before it writes any row: syncs of several
  connections of one budget hold it together and stay parallel, as before. An apply and a revert
  take it EXCLUSIVELY before they lock rows: they wait for every running sync of the budget (and
  a sync that starts meanwhile waits for them), so the two never hold row locks in different
  orders (no deadlock). Apply and revert set `lock_timeout = 5s` for their transaction: when the
  lock or a row is not free in time they answer 409 `bank_sync_running` ("a bank sync is
  running, try again in a moment", en and pt-BR) and write nothing, rather than a request that
  outlives a proxy timeout and still commits. A SQL prefilter trims the text exactly as
  JavaScript's `trim()` does (tab, newline, no-break and other Unicode spaces, BOM), so a raw text
  with those at an end is still found.
- **Reads.** Apply and preview do not read or lock every imported row of the budget: the rule's
  own match (is / contains / starts with / ends with, lower-cased) is made in SQL on the row's real
  text as a prefilter, and `FOR UPDATE` locks exactly those rows (plus synced rows of unknown text,
  which are counted). A pattern with a non-ASCII character is not prefiltered (SQL `lower()` is
  locale dependent), so such a rule reads every imported row. `rename_rule_apply_rows` is indexed
  by transaction id.
- **Side effect, a fix over main: re-importing main's statement files into a fresh-start copy
  imports nothing.** Fresh Start carries the history of linked accounts with the import ids
  unchanged, so a carried row's key names the OLD budget's payee id. Main looked rows up under the
  new budget's payee id, found none and imported every row again (the duplication review mkrt-5
  recorded); `/bulk` now also recognises a stored row by amount, date and text under any key, so
  the carried rows are duplicates (`connections/rename-rules-forward.test.ts`, "fresh-start copy").
- **What does NOT change.** No rule change touches the stored rows' categories, balances,
  import ids, import names or hints. The rule operations' descriptions say so. Rows main
  stored, and the legacy-row recognition of the earlier task, are exactly as before.
  Proven by `connections/rename-rules-forward.test.ts` (the capture of main, rules added,
  edited and removed through the API, with the stored provider object carrying the text, lacking
  it, or absent, and an object that changes on every pull; sync twice and statement re-import twice:
  0 updated, 0 imported, no payee created; new rows and a changed bank text take the rules; legacy
  rows keep their payee when only the date or amount moves; apply on rows of the earlier form,
  revert, the skips, transfer hints).

## Manage Payees: transfer payees and several renaming rules (budget-p8td, transfers T4)

Client only (`client/src/features/payees/`); plan `.agents/plans/2026-11-24_transfers-refactor.md`.

- **Two groups in the list, both collapsible:** "Payees" and "Transfer Payees (N)", one per
  account (the list is requested with `include_transfers`). A transfer payee is shown as
  "Transfer : <the account's current name>"; the payees of CLOSED accounts come last in the
  group, tagged "Closed" (a closed account keeps its payee, so its rules and rows stay
  reachable). A search shows its matches in both groups whether collapsed or not.
- **A transfer payee shows its name (read only), activity, the Renaming card and the note that
  the app owns it.** No rename, merge, hide, delete or categorization control. The card's hint
  says what a rule on it really does (rows are offered as a transfer, not renamed), not the
  YNAB sentence "will be renamed".
- **The Renaming card is the same for every payee:** all rules of the payee (`rename_rules`),
  four match types, add / edit / remove through the rule operations (the single-rule
  endpoint stays only for the import flow). A row saves on blur / Enter or when its match
  type is picked; an emptied stored rule is not removed by accident (the row goes back), only
  the remove button removes. Errors (`rename_rule_exists`, `rename_rule_too_short`,
  `bank_sync_running`) show as the translated server message under the row.
- **"Apply to past transactions" is per rule:** a preview (count, newest rows, what is left
  alone and why), Apply, then a toast with Undo (revert by `apply_id`). The toast belongs to
  the screen, so it survives picking another payee.
- **"Treat as transfer" and the "Transfer rules" tab are gone from the UI; no data is deleted.**
  A payee that still has an old "auto" or "account" rule shows a notice with an account picker
  and Convert: it adds `is <payee name>` on the chosen account's transfer payee, then clears
  the old rule (transfer-rule mode `off`). A rule that was already added (a conversion that
  stopped half-way) is not added twice. An "account" rule starts with its account picked.
  "Never a transfer" stays (owner decision 1), as a checkbox on ordinary payees; it is
  hidden while an old rule is waiting for its conversion.

## Transfers on the client: what a pointer-less row is, and what Reflect counts (budget-p8td review)

- **Existing rows keep their numbers.** A row with no server pointer is resolved exactly as before the
  refactor: by its payee's NAME ("Transfer : <account>") when that names exactly one other account
  (`legacyTransferAccountByName`, client `domain/transfers.ts`; same guards: case and spacing, own account
  and ambiguous names are not transfers). The payee's link (`transfer_account_id` of the payee) is NOT read
  for such a row: it can answer differently from the name (two same-named accounts, "(2)" names, stale
  names) and would move Ready to Assign with no user action. The server repair turns those rows into
  pointers, after which the pointer is the answer. Checked with a probe of main against the branch on the
  same wire rows: 0 numeric differences (Ready to Assign, card payments, every category, every row).
- **Reflect.** Its monthly trend and spending by category leave out exactly what the engine skips: a
  transfer between two on-budget accounts (`isEngineTransfer`, both accounts on budget). Intended change
  for the owner: Reflect's past monthly totals drop, because on-budget transfers and card payments are no
  longer counted as spending. The register's "Category not needed" and the category lock look at the peer
  account only (`isBudgetTransfer`), as the register always did.
||||||| fba921e

## Continuous api/web deploy on main (2026-11-26)

Why: server code reached the cluster only through `task release` (version bump,
tag, `release.yml`), so fixes sat on main until a release was cut. Now any push
to main that can change an image is built and rolled by ArgoCD.

- `deploy.yml` runs on a push to main touching `api/**`, `client/**`,
  `shared/**`, `docker/**`, `.dockerignore` or itself. It builds `budget-web`
  and `budget-api` for linux/amd64 + linux/arm64 tagged `sha-<commit>` (one
  immutable image per commit) and commits that tag for `budget-web`,
  `budget-api` and `budget-worker` into `k8s/values.yaml`.
- The pin commit is made by the bot on top of current main, retried up to 3
  times: a push that landed during the 10-20 min build must not be rolled back,
  and a concurrent pin (another deploy or a release) can move main between the
  fetch and the push. Runs share the `deploy-main` concurrency group with
  `cancel-in-progress`: a newer push cancels an older build instead of letting
  the cluster roll to stale code afterwards.
- `release.yml` keeps building the versioned web/api/admin images and creating
  the GitHub release, but pins ONLY `budget-admin`. Pinning the api/web version
  tag there would roll them back to an older commit whenever main moved during
  the build, and the next deploy would not correct it (its pin landed before
  the release pin). The admin image has no continuous deploy, so the release
  pin is its deployment.
- Docs-only pushes deploy nothing (path filter). Rollback is unchanged: commit
  the tag to run into `k8s/values.yaml` (`sha-<commit>` for any main commit,
  `<version>` for a release).
