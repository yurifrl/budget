# Architecture

State of `main` after phase 5e (client) and 5b/5c/5d (api, shared).

## Packages

```
budget/
  shared/   pure TypeScript, zod only        (stable)
  api/      Bun + Hono API, worker, CLI, MCP (lifted from syscd, unchanged behaviour)
  client/   Expo SDK 58 app, iOS + web
  admin/    Vite + React SPA, jobs ledger    (copy of syscd's admin)
  deploy/   Dockerfile.{web,api,admin}, httpd.conf
  k8s/      values.yaml: image tags ArgoCD deploys
  scripts/  release-bump, release-changelog, db-init, e2e-api
  .github/workflows/  ci, version, release, app-release
```

No root `package.json`; each package installs and runs on its own. Code is
shared as source: `@shared/*` maps to `shared/src/*` in every tsconfig, Vite
alias and Metro `watchFolders`. `shared/` owns the only zod; the other three
override `zod` to `link:../shared/node_modules/zod`, so `shared/` installs
first. Details and trade-offs: `docs/decisions.md`.

## shared/

`src/operation-contract.ts` (the contract type, `defineOperation`,
`inputLocations`, `OperationOutput`), `src/contracts/{budget,connections,features,rates,user,oauth,jobs}`
(one operation contract per endpoint: method, path, zod input and output;
budget and connections keep their response row schemas in `outputs.ts`),
`src/contract-request.ts` (the request builder every client uses),
`src/errors.ts` (`{ error, code }`), `src/features.ts` (the typed feature
list and its resolution rule), `src/domain/{payees,transfers}` (pure
logic both sides need), `src/i18n/` (typed `t()` engine, `common` and `errors` catalogs; `docs/i18n.md`), `src/validation.ts` (uuid, dates, `milliunitsSchema`,
`currencyCodeSchema`, `MONEY_UNIT_RULE`), `src/zod.ts`. Lint: only zod, no
React, hono or pg. Wire rules: every amount is integer milliunits with no
unit suffix (phase 5d); see `shared/README.md`.

## api/ (hono, pg, Temporal, MCP SDK)

Entrypoints in `src/`: `index.ts` (HTTP), `worker.ts` (Temporal worker +
outbox relay), `cli.ts`, `mcp.ts` (stdio). Features: `core` (db, migrate,
operation helpers), `user`, `oauth`, `mcp`, `cli`, `jobs`, `budget`,
`connections`, `rates`, `features`. `catalog.ts` lists every shared contract; the CLI and
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
- **Auth.** Two sign-in providers, both ending in the same stateless
  `budget_session` (HS256 JWT, cookie on web, Bearer on native) and the same
  `resolveOrCreateSessionUser` capture: Cloudflare Access
  (`user/access.ts` verifies the `Cf-Access-Jwt-Assertion` RS256 JWT against
  the team JWKS; `user/access-routes.ts`: `/auth/access`,
  `/auth/access/native`, `POST /auth/exchange`) and Google
  (`user/authz.ts`: `/auth/google*`, `/auth/token`). A provider's routes
  answer 404 unless it is configured; `GET /auth/providers` says which are on
  and the client's `LoginGate` picks (web + Access: one automatic redirect,
  loop-guarded, and none after an explicit sign-out until a sign-in button is
  pressed; signed out or unreachable it shows `features/auth/LandingPage`).
  The OAuth consent page hands logged-out browsers to Access
  when configured, else Google. Who may sign in: for Access, whoever the
  Cloudflare policy lets through (no API-side list; a first-time person gets a
  user row and zero budgets, an invited e-mail links to its existing row); for
  Google, only `AUTH_ALLOWED_EMAILS` (`googleAllowed`). Access-minted sessions
  carry `idp: 'access'` and OAuth grants remember it (`oauth_grants.idp`), so
  the per-request check `isAllowed(email, idp)` (`user/config.ts`) holds Google
  sessions to the list and Access ones to "Access is configured".
  `requireUser` reads `users.status` per request: `disabled` = 401
  `account_disabled` (how a person is revoked) and stamps
  `users.signed_in_at` (what ends an invitee's "pending" state). Config comes
  only from `auth-env.ts` (boot guard: `checkAuthEnv`). Decisions and threat
  model: `decisions.md`, "Access sign-in" and "Multi-user".
- **Access.** A person reaches a budget only as its owner or a member
  (`budget_members`); nobody else does, the `admin` role included (it is an
  operator role: jobs ledger, app-wide sync window, claiming legacy unowned
  budgets). `budgetAccess` authorises the `budget_id` in query/body; path
  `:id` routes re-scope by `budget_id` in SQL; rename/archive/delete/restore/
  fresh start and removing people are owner-only. `GET /budgets` returns only
  the caller's budgets with `is_owner`, `owner` and `member_count`.
  `src/access.test.ts` classifies every catalog operation, drives each
  path-param and `budget_id` operation as a non-member (and as a non-member
  admin) and expects 404, then shares the budget and expects the reads to open.
- **Features.** On/off switches for everyone or for one person. The list is
  code (`shared/src/features.ts`: key, group, description, default); nothing creates
  a feature at runtime and a stored key that is no longer listed is ignored.
  Stored values: `public.feature_overrides` (migration 0103; `user_id` NULL =
  everyone; who and when on each row, no history). Order: the user's override,
  else the everyone value, else the default. The API enforces with
  `isEnabled(db, feature, userId)` from the `features` barrel, called in
  handlers and Temporal activities only (never a workflow file) and reading
  the database on every check. `GET /features` gives a signed-in user their
  own values (client: `useFeatures()` in `state/useFeatures.ts`, refetched on
  focus, show/hide only); `/admin/features` (admin + first-party session)
  sets and clears them. Never called "flags": in the client a flag is a
  transaction colour.
- **Bank key sets.** A person connects banks with their OWN Pluggy keys; the
  installation's shared keys (`PLUGGY_*`) are only for people with feature
  `shared-pluggy-key` on. Own keys: `public.connection_credentials` (migration
  0104, one row per user and provider; client id in the clear, the secret as
  AES-256-GCM ciphertext + nonce + key version, sealed by `core/secret-box.ts`
  with the master key from `CREDENTIALS_ENCRYPTION_KEY`, which
  `secrets-env.ts` requires in a cluster). Operations: `GET|PUT|DELETE
  /connections/credentials` (the save checks the pair with the provider's
  auth call; the read never returns the secret). Every connection records the
  key set that created its item (`connections.key_source` 'shared' | 'own',
  `key_client_id`), because a Pluggy item is reachable only with those
  credentials. `connections/keys.ts` is the one place that picks a key set: a
  new connection gets own keys if saved, else shared if the feature is on,
  else 403 `own_keys_required`; an existing one always uses its own; register
  probes which key set holds a new item before recording it.
  `getAggregator(provider, credentials?)` builds the adapter on either. A
  connection whose key set may not be used is `status = 'paused'` (never
  deleted): `reconcileKeyAccess` sets and clears that wherever a connection is
  used or shown (sync activity, sweep, connect-token, upstream, lists), so it
  follows the feature with no hook on the admin toggle. Own-key connections
  get no webhooks (sweep and manual sync only); the webhook route and its
  shared secret are unchanged.
- **AI keys.** Category suggestions run on an AI provider key: the person's own
  (`public.ai_credentials`, migration 0109, one row per user, the secret is
  AES-256-GCM ciphertext sealed by `core/secret-box.ts` like bank keys) or the
  installation's shared key when feature `shared-ai-key` is on for them
  (`AI_SHARED_API_KEY` + `AI_SHARED_PROVIDER`; the model is the
  `app_settings.aiSharedModel` admin setting, falling back to
  `AI_SHARED_MODEL`). Own wins; with neither, 403 `own_ai_key_required` (no
  paused state). `api/src/ai/` is the provider port (`chat` with tool calls and
  structured output, authenticated `verifyKey`, `listModels`) plus five
  adapters — OpenRouter, Anthropic, OpenAI, Z.ai, DeepSeek — with the provider
  guessed from the key shape and overridable (Z.ai keys have no documented
  shape, so that provider is chosen by hand). Saving checks the key with an
  authenticated call (OpenRouter's `/key`; OpenAI and DeepSeek's model list;
  Anthropic's one-model Models call; Z.ai's documented tokenizer, because its
  API documents no model list) and never sends a stored key to another
  provider's host: `providerFor(resolvedKey)` is the only way to build an
  adapter for a stored key. OpenAI's `/models` needs the separate
  `api.model.read` scope, so a 403 there still proves the key authenticated
  and is reported later as 403 `ai_key_forbidden` when listing, not as a bad
  key. Z.ai's model list is the set its OpenAPI spec documents. A chat deadline
  is the 60 s floor or enough for the requested token cap at 25 output
  tokens/s (Anthropic's 16k default → 640 s), and a timed-out chat is
  `permanent`, never retried, because the aborted generation may already be
  billed. Operations:
  `GET|PUT|DELETE /ai/credentials`, `GET /ai/credentials/test`,
  `POST /ai/provider-detect`, `POST /ai/models`; the key is never returned.
- **Repeat-rule tick.** Still an in-process interval in the API
  (`BUDGET_REPEAT_TICK`, off in production); the generation code is
  `budget/domain/repeat-generation.ts`.

## client/

Expo Router app (iOS + web). `client/VERSION` is the iOS app release version
(its own sequence); the web export takes `api/VERSION` instead (see Release).
Layout since phase 5e (`client/src/`):

```
app/        routes only: thin stubs re-exporting a feature barrel; _layout.tsx
            is the composition root (providers, LoginGate, StoreMoneyFormatProvider)
shell/      BudgetLayout (rail / drawer / tabs, sheets it hosts), rail/
            (title + collapse button, nav, accounts, account row at the
            bottom), SettingsMenu (pane-stack host opened upward from that
            row; placement in menuPlacement.logic.ts), runtime.ts (DI container + store),
            context.ts (useBudgetShell) and menuNav.ts (useMenuNav): the only
            shell files features may import
features/   home plan accounts banks payees import backup reflect spending
            settings people auth profile: each holds its screens, components,
            hooks (useXxx.ts) and feature-local logic (*.logic.ts + tests);
            index.ts is its public surface
domain/     pure TypeScript (only itself and @shared/*): the engine
            (zeroSum.ts), engine helpers (engine.ts), format.ts (formatters
            taking prefs explicitly), targets, people, plan/register rules,
            fixtures in __fixtures__/
state/      store.ts (static configureStore), hooks.ts (typed hooks), ui.ts
            (budgetUi slice: active budget/month, filters, display toggles,
            format prefs, flag labels, Hide Amounts), planEdits (undo/redo
            history), budgetSettings.ts (the one listener that loads and saves
            the per-budget settings blob), thunks, store-backed hooks
            (useBudgetModel, useBudgetMonth, useDisplayPrefs, ...)
ui/         theme.ts (the one theme), primitives/ (MoneyInput, AmountCell,
            buttons, sheets...), dropdown/ (pickers shared by features),
            moneyFormat.tsx (useMoneyFormat context), avatar/, combobox, portal
platform/   api base query, di, storage (KVStore, Keychain secret store), config,
            state listeners, file picker
budget/data/       RTK Query api, wire rows, mapping (owned by the data-layer
                   work; not moved yet). budget/{domain,state,import}/*.ts
                   are one-line re-export shims kept only for data/'s imports
profile/api.ts     profile RTK Query slice (+ its pure model.ts), data layer
```

Rules (`client/eslint.config.js`, `src/architecture.test.ts`):
`app → shell → features → {state, data} → ui → domain`, with `platform`
below everything but domain. A feature imports another feature only through
`@/features/<x>` (its `index.ts`) and of the shell only `shell/context.ts`
and `shell/menuNav.ts`; the shell imports features through barrels too.
`state/` and the data layer know no feature, shell or UI; `ui/` imports only
`domain/` and `platform/`; `domain/` imports only itself and `@shared/*` and
no React/RN/Expo. `architecture.test.ts` fails on any runtime import cycle
under `src/` and on a non-pure domain import.

- **Navigation and the active budget.** The root stack is `index` (the home
  page, `features/home`), `(budget)` (the shell), `profile`, `connected-apps`.
  `/` is always the home page: "My budgets" (`is_owner`), "Shared with me"
  (with the owner), archived ones collapsed, create, invite (the People pane
  of `features/people` in a sheet), profile and sign out; with zero budgets
  it is the first-run page. It shares its frame with the landing page
  (`ui/BrandedPage`). Opening or creating a budget there is the only way one
  becomes active: `switchBudget` (redux + KV key `budget.activeBudgetId`),
  then push `/overview` (phone) or `/plan`. Budget routes carry no budget
  id; a reload or deep link inside `(budget)` restores the persisted id
  (`restoreActiveBudget`), and `shellGate` (`shell/rail/rail.logic.ts`)
  decides: render the shell, wait, or redirect to `/` (no id, stale id, zero
  budgets, list failed). The shell never picks a budget. The way back: the
  "All budgets" row at the top of the rail's account menu, and a house button
  beside the menu button on tablet/phone (one tap). Owner-only controls (rename, archive, delete, Fresh
  Start, restoring a backup, removing a person) are not rendered for members
  (`is_owner` on the list row, `can_manage` on members).
- **Wire boundary.** `budget/data`: `data/api.ts` re-exports one RTK Query
  api assembled from `data/api/{base,budgets,members,plan,payees,register,connections}.ts`
  (`injectEndpoints`), every request built with `contractRequest`; `rows.ts`
  and `connections.ts` are `z.infer` types of the contracts' output schemas;
  `mapping.ts` converts wire milliunits to the domain's cents and back.
  Wire-typed view logic lives in the feature that uses it (e.g.
  `features/banks/model/`), not in `domain/`.
- **Engine.** `domain/zeroSum.ts` (`computeBudgetMonth`) is the canonical
  engine (`docs/budget-engine-spec.md`); `domain/engine.ts` holds helpers
  around it (balances, assigned lookups, target funding, Cost to Be Me, the
  legacy activity recompute data/mapping uses) and never derives month
  figures itself.
- **Display prefs.** Format prefs, flag labels and the Hide Amounts mask live
  in the budgetUi slice; `state/budgetSettings.ts` hydrates them from the
  per-budget KV blob on every `setActiveBudget` and persists settings actions.
  Components format through `useMoneyFormat()` (`ui/moneyFormat.tsx`, fed from
  the slice at the root), pure code takes a `MoneyFormat` argument. No module
  singletons, with one deliberate exception: the active language (`@shared/i18n`,
  set by `platform/locale`) is a device-wide singleton, because it is a property
  of the device, not of a budget, and pure code (`domain/`, `*.logic.ts`) must
  translate without a `t` parameter threaded through every signature (`docs/i18n.md`).
- **Session token.** Web: httpOnly cookie. Native: the Keychain via
  `platform/storage/secretStore.native.ts` (expo-secure-store), moved once
  from AsyncStorage on first read (`sessionToken.ts`).

## admin/

Hash-routed SPA: the jobs ledger (`Runs`, `RunDetail`) over the `jobs_*`
contracts, `Users` (`/admin/users`; each user's features are a dropdown, grouped and
filterable) and `Features` (every feature under its group with the everyone
switch; `#/features/<key>` shows one feature's users). API base URL: `VITE_API_URL` at build time, or a
`/config.json` `{ "apiUrl": ... }` mounted into the image at runtime.
Requests are built with `@shared/contract-request` (the copy is gone).

## Build, CI, release

- Images (context = repo root): web (Expo web export, busybox httpd :8080,
  `EXPO_PUBLIC_API_URL` build arg), api (+ worker), admin (`VITE_API_URL`).
- `ci.yml`: one job per package plus Docker build checks. The api job runs
  against a Postgres 18 service container, then `scripts/e2e-api.sh` (OAuth
  consent + MCP over HTTP; no Temporal).
- Two independent releases (decision 2026-11-23), each with its own version
  file, tag and workflow. Both versions are `YYYY.MM.DD[-NN]`
  (`scripts/release-bump.ts api|client`), but the sequences are separate.
- Server release: `task release` bumps only `api/VERSION` and pushes main.
  `version.yml` writes the changelog section (OpenRouter notes if
  `OPENROUTER_API_KEY` is set, else the commit list), tags `v<VERSION>` and
  dispatches `release.yml`: push `ghcr.io/<owner>/budget-{web,api,admin}`
  (amd64 + arm64; tags version, sha, latest), then commit the version into
  `k8s/values.yaml` (`budget-worker` follows `budget-api`) and create the
  GitHub release `v<VERSION>`. ArgoCD rolls the Deployments from that file.
  The web image is part of this release: `Dockerfile.web` passes
  `api/VERSION` as `WEB_RELEASE_VERSION`, so the web menu shows the server
  version, not `client/VERSION`.
- iOS app release: `task release:app` bumps only `client/VERSION` and pushes
  main. `app-release.yml` tags `app-v<VERSION>`, then (only when the repo
  variable `EAS_ENABLED` is `true`) runs the EAS production iOS build, submits
  it to App Store Connect and creates the GitHub release `app-v<VERSION>`
  (not marked latest). It builds no images and deploys nothing; a
  `workflow_dispatch` rebuilds the current `client/VERSION`.

## Runtime hosts

web `https://budget.syscd.live`, API `https://budget-api.syscd.live`, admin
`https://budget-admin.syscd.live`. The API shares syscd's Postgres database
for now (hence the migration numbering rule).
