# Morning: what happened overnight and what you need to do

Written 2026-11-18 (last update 11:30 UTC) by the overnight migration run.

## 1. Where things stand

The budget app now lives in its own private repo, https://github.com/yurifrl/budget
(shared contracts, a Bun/Hono API with worker, an Expo client for web and iOS,
and the jobs admin). Phases 0 to 5 of `docs/migration-plan.md` are merged on
`main`, including the refactors (wire amounts in milliunits, contract outputs,
the store layer, the client restructure). CI on `main` is fully green since
run 44292747999 (the first green run; the release commit's run 44293290924 and
run 44293887170 are green too). The current release is `2026.11.18-01`: images
`ghcr.io/yurifrl/budget-{web,api,admin}:2026.11.18-01` exist for amd64 and
arm64 (Release run 44293320363), `k8s/values.yaml` pins them (commit
`e3284c7`), and home-systems `main` declares them inline in
`k8s/applications/budget.yaml` (commit `6ada9860`). The app is declared in
the cluster but cannot run yet: it has no secrets until you do step 1.
**The original app, syscd-app, was not modified** (no file, commit or config
change), and its API still answers 200 at https://api.syscd.live/health.

Public probes at 2026-11-18 11:22 UTC, as expected before step 1:

| URL | HTTP |
|---|---|
| https://budget-api.syscd.live/health | 503 (`no healthy upstream`: no API pod is ready) |
| https://budget.syscd.live | 302 to Cloudflare Access |
| https://budget-admin.syscd.live | 302 to Cloudflare Access |
| https://api.syscd.live/health | 200, `{"ok":true,"version":"2026.11.17-03"}` |

## 2. Do these, in order

### 2.1 Run the 1Password script (nothing starts until this is done)

`op` was not signed in overnight, so no 1Password item exists yet.

```sh
op signin --account my.1password.com
cd ~/Workdir/Yuri/budget
scripts/create-1password-item.sh          # OP_VAULT defaults to Kubernetes
```

It creates ONE item, `budget`, in vault `Kubernetes` (the vault the
`onepassword` ClusterSecretStore reads, where `syscd-app` lives). It never
prints a secret value, and it skips the item if it already exists.

| Fields of `budget` | |
|---|---|
| generated | `DB_PASSWORD`, `DATABASE_URL`, `SESSION_SECRET`, `TEMPORAL_DB_PASSWORD` (Temporal's Postgres role), `ARGOCD_SSH_PRIVATE_KEY` (ArgoCD's read-only deploy key; the script adds the public half to yurifrl/budget) |
| set to `false` | `PLUGGY_SANDBOX` |
| empty, for you | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS`, `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_WEBHOOK_SECRET`, `PLUGGY_ITEM_IDS`, `OT_SERVICE_TOKEN` |

**State on 2026-11-18 (done from the session, values never printed):** item
`budget` holds `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`AUTH_ALLOWED_EMAILS` (copied from `syscd-app`), plus `TEMPORAL_DB_PASSWORD`
and `ARGOCD_SSH_PRIVATE_KEY` copied from the original `budget-temporal` and
`argocd-budget` items, which are now archived. The deploy key is the one the
script registered on yurifrl/budget, so nothing needs re-registering. The
`PLUGGY_*` fields are still empty on purpose (section 5).

`DATABASE_URL` is `postgres://budget_app:<DB_PASSWORD>@pg-rw.databases.svc.cluster.local:5432/budget`,
which is what `api/src/index.ts` and `api/src/worker.ts` read. If syscd-app's
own `DATABASE_URL` carries query parameters (for example `sslmode`), add the
same ones; this was not checked (its secret was not read).

If the vault has a different name, run with `OP_VAULT=<name>`. The script
was reviewed but has never been run.

Within about an hour (the ExternalSecret refresh; to force it, see 2.8) this
gives the CNPG roles `budget_app` and `budget_temporal` their passwords,
creates the `budget_temporal*` databases, starts Temporal (schema job, then
namespace job) and boots the worker. **The worker applies migration
`0100_account_currency.sql` to the shared `budget` database when it first
boots** (see section 3). The API keeps crash-looping until 2.2, by design.

### 2.2 Fill the empty fields of item `budget`

| Field | Value | Copy from |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id | item `syscd-app`, field `GOOGLE_CLIENT_ID` (reuse the client, step 2.3) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | `syscd-app` `GOOGLE_CLIENT_SECRET` |
| `AUTH_ALLOWED_EMAILS` | comma-separated e-mails | `syscd-app` `AUTH_ALLOWED_EMAILS` |
| `PLUGGY_CLIENT_ID` | Pluggy client id | `syscd-app` `PLUGGY_CLIENT_ID`; **read the warning below first** |
| `PLUGGY_CLIENT_SECRET` | Pluggy secret | `syscd-app` `PLUGGY_CLIENT_SECRET` |
| `PLUGGY_SANDBOX` | created as `false` (production; the code defaults to `true` when the field is absent) | change only if `syscd-app` `PLUGGY_SANDBOX` differs |
| `PLUGGY_WEBHOOK_SECRET` | the shared secret Pluggy sends | `syscd-app` `PLUGGY_WEBHOOK_SECRET` |
| `PLUGGY_ITEM_IDS` | optional | `syscd-app` `PLUGGY_ITEM_IDS` if set; empty is fine |
| `OT_SERVICE_TOKEN` | optional machine bearer token; empty disables that lane | leave empty, or a new random value of 48+ characters |
| `CREDENTIALS_ENCRYPTION_KEY` | **required** (budget-api and budget-worker refuse to boot without it): master key that encrypts users' own Pluggy secrets. The script generates it for a new item; an item created before this field existed needs it added by hand | new value: `openssl rand -base64 32`. Never reuse another secret; never change it afterwards (stored secrets become unreadable and users must save their keys again) |

Do not add a `CLIENT_USER_ID` field unless you want a value other than
`syscd-app`: the API takes an empty value literally instead of falling back to
the `syscd-app` default, which would detach the existing Pluggy items
(follow-up `budget-hd3`).

The API boots once the Google pair, `AUTH_ALLOWED_EMAILS` and `SESSION_SECRET`
are set (`api/src/auth-env.ts`). Pods read the values on their next restart
after the secret syncs (envFrom): see 2.8.

**Warning, Pluggy:** both workers (syscd's and budget's) run the
`connections-sweep` schedule every 6 hours against the same connections in the
shared `budget` database. Until syscd's budget is switched off (section 5),
leave `PLUGGY_CLIENT_ID` and `PLUGGY_CLIENT_SECRET` empty in `budget`, so only
syscd syncs banks.

### 2.3 Google OAuth console

Console > APIs & Services > Credentials > the OAuth client syscd uses (Web
application). Add to **Authorised redirect URIs**:

```
https://budget-api.syscd.live/auth/google/callback
https://budget-api.syscd.live/auth/google/native/callback
```

(`api/src/user/authz.ts`: web flow `/auth/google` -> `/auth/google/callback`;
native flow `/auth/google/native` -> `/auth/google/native/callback`.) No
JavaScript origins are needed (server-side redirects only).

### 2.4 Pluggy dashboard (only at switch-off)

The new webhook URL is `https://budget-api.syscd.live/connections/webhook/pluggy`
(`api/src/connections/webhook.ts`). The app never sends a `webhookUrl` when it
creates items, so the URL is the one set in the Pluggy dashboard. Leave the
existing one (`https://api.syscd.live/connections/webhook/pluggy`) in place
while syscd's budget runs; switch it in section 5.

### 2.5 The `$values` source (release auto-deploy): done

Enabled 2026-11-21 (home-systems 6d6fe375). The budget Application's third
source is `git@github.com:yurifrl/budget.git` (`main`, `ref: values`) and the
support chart reads `$values/k8s/values.yaml`. ArgoCD fetches it through the
`argocd-budget` repository secret (1Password item `budget` field
`ARGOCD_SSH_PRIVATE_KEY`); its public half is the read-only deploy key
`argocd@home-systems (read-only)` on yurifrl/budget. The chart prefers
`imageTags[<deployment>]` over the inline `tag:` values in budget.yaml, which
are only a fallback, so `task release` rolls the cluster by itself once CI
passes: do not bump the tags in home-systems.

If that key is removed or rotated without updating GitHub, manifest
generation fails for the whole Application (pods keep the last synced tags).
Check with `argocd repo list --core` (in namespace `argocd`).

### 2.6 Images: only if pods show ImagePullBackOff

The three GHCR packages are private, like syscd's (`syscd-app*`), which the
nodes pull with the ghcr.io registry auth in their Talos machineconfig. If
budget pods still show ImagePullBackOff, make them public:
https://github.com/users/yurifrl/packages/container/budget-web/settings (and
`budget-api`, `budget-admin`) > Danger Zone > Change visibility > Public.
GitHub's REST API has no endpoint for this.

### 2.7 Expo / EAS and the App Store (does not block the web deploy)

```sh
cd ~/Workdir/Yuri/budget/client
bunx eas-cli login
bunx eas-cli init                 # creates the EAS project for slug `budget`, owner yurifrl
bunx eas-cli build:configure      # creates eas.json (app-release.yml uses profile `production`)
```

- Put the printed projectId into `client/app.config.ts` `extra.eas.projectId`
  (a comment marks the spot) and commit eas.json.
- Expo token: https://expo.dev/settings/access-tokens, then
  `gh secret set EXPO_TOKEN --repo yurifrl/budget`.
- `gh secret set EXPO_APPLE_APP_SPECIFIC_PASSWORD --repo yurifrl/budget`
  (appleid.apple.com > App-Specific Passwords).
- `gh variable set EAS_ENABLED --body true --repo yurifrl/budget`.
- Since 2026-11-23 the app ships on its own: `task release:app` (bumps
  `client/VERSION`, `app-release.yml` builds and submits). `task release`
  never submits the app.
- App Store Connect: new app, bundle id `live.syscd.budget` (register the
  identifier at developer.apple.com first, or let `eas build` do it), name
  "Budget". Android / Play: not now (decision D7); the package is also
  `live.syscd.budget`.

### 2.8 Verify

```sh
curl -s https://budget-api.syscd.live/health    # {"ok":true,"version":"2026.11.18-01"}
curl -sI https://budget.syscd.live              # 302 to Cloudflare Access, 200 after login
curl -sI https://budget-admin.syscd.live        # 302 to Cloudflare Access (Admin policy)
curl -s https://api.syscd.live/health           # syscd untouched, 200
```

On the cluster:

```sh
kubectl -n argocd get application budget
kubectl -n budget get pods,externalsecrets
kubectl -n databases get externalsecret budget-app-db-roles budget-temporal-db-roles
kubectl -n databases get databases.postgresql.cnpg.io | grep budget
kubectl -n databases get cluster pg -o jsonpath='{.status.managedRolesStatus}'
kubectl -n budget logs deploy/budget-api | head     # "FATAL: auth misconfiguration ..." until 2.2
```

Force a resync instead of waiting for the hourly refresh:
`kubectl -n budget annotate externalsecret budget force-sync=$(date +%s) --overwrite`
(the same for `budget-temporal-db`, and for the two `*-roles` in `databases`),
then `kubectl -n budget rollout restart deploy/budget-api deploy/budget-worker`.

Then sign in at https://budget.syscd.live and open the admin at
https://budget-admin.syscd.live (Temporal UI: https://budget-temporal.syscd.tech,
tailnet only).

### 2.9 Roll back

1. home-systems: delete `k8s/applications/budget.yaml` and commit. The
   Application has the resources finalizer, so ArgoCD prunes the `budget`
   namespace's resources and the ExternalSecrets in `databases` and `argocd`.
2. home-systems `k8s/applications/postgres.yaml`: remove the `budget_app` and
   `budget_temporal` roles and the `budget_temporal` /
   `budget_temporal_visibility` databases. The databases have
   `databaseReclaimPolicy: retain`: removing the entries deletes the CNPG
   `Database` objects but keeps the Postgres databases; drop them by hand if
   wanted (`DROP DATABASE budget_temporal; DROP DATABASE budget_temporal_visibility;`).
   Roles: set `ensure: absent` first (CNPG drops the role), then remove the
   entry; a role that owns objects cannot be dropped (see 7.1). Never touch
   the `budget` database entry or the `syscd` role.
3. home-systems-values `cloudflare-access/values.yaml`: remove `budget-api`
   and `budget-admin-live`.
4. Migration 0100 stays (a nullable column syscd ignores, see section 3). To
   remove it anyway: `ALTER TABLE accounts DROP COLUMN currency;` and delete
   its row from `schema_migrations`.

## 3. Decisions waiting for you

- **Postgres backups look disabled.** home-systems `k8s/applications/postgres.yaml`
  has `backups: enabled: false` on the `pg` cluster, with a TODO
  (`home-systems-jfr.4`) to choose MinIO or Longhorn snapshots. You said
  backups exist; this file says otherwise for CNPG. The new API writes to the
  same live `budget` database as syscd, so please confirm a backup exists
  before step 2.1.
- **Migration 0100 on the shared live database.** `0100_account_currency.sql`
  adds a nullable `accounts.currency` column (no default, no backfill, a CHECK
  for three upper-case letters) to the live `budget` database. It runs the
  first time the new worker boots (right after 2.1, `api/src/worker.ts` runs
  migrations at start) or the API boots. `docs/decisions.md` ("G1") lists
  every syscd statement on `accounts` and why syscd keeps working; it was
  checked by reading syscd's code, not by running syscd against the column.
- **Four cross-budget reference holes and the restore bug are fixed only in
  the new API.** A member of one budget could point rows at another budget's
  rows through body-carried ids (assignments set/batch `category_id`,
  categories reorder `moves[].group_id`, transactions PATCH `category_id` and
  `matched_transaction_id`); restore linked `Transfer : X` payees to accounts
  named X in other budgets. All five are fixed here (commits `60b348a`,
  `5b17747`) and are still live in syscd-app, which serves the same data.
- **Repair runbook not run.** `docs/runbooks/transfer-payee-cross-budget.md`
  diagnoses and repairs payees damaged by the restore bug. It was written but
  never run against any database. Run its read-only diagnostic first.
- **The name `yurifrl/budget`.** It used to redirect to your 2019 repo (now
  `budget-haskell`); creating this repo replaced that redirect.
- **Images are private**, like syscd's. See 2.6 if pulls fail.
- **Renovate is now on.** `renovate.json` was added (React Native core grouped,
  `expo-router` held at 58.0.23, ESLint/TypeScript majors held, Expo-managed
  minor/patch versions in `client/` left to `expo install`). Before the last
  rule landed Renovate opened PR #2 (react-native-svg 15.16.1) and PR #3
  (react 19.3.1); both failed CI on expo-doctor, were not merged, and
  Renovate auto-closed them once the rule was on `main`. PR #1 (onboarding)
  was auto-closed when `renovate.json` landed. No PR is open now.
- **Pinned client packages.** `client/package.json` `expo.install.exclude`
  lists `expo-router` (browser Back fix), async-storage 3.1.1 (syscd's major),
  and four packages Expo published on 2026-11-17 that this Mac's 48-hour
  package-age policy would not install yet (`expo`, `@expo/ui`,
  `expo-file-system`, `expo-web-browser`; follow-up `budget-ef9`, after
  2026-11-19 12:00 UTC). Reasons in `docs/decisions.md` ("expo-doctor").

## 4. Not verified overnight

- Anything inside the cluster: the API was unreachable from this Mac and no
  tunnel was opened. Only the public URLs above were checked.
- Real Google sign-in (all local runs had auth disabled).
- The iOS simulator on the final code (only the iOS bundle export was built).
- Android (not targeted, D7).
- Bank linking with real Pluggy credentials.
- The 1Password script itself (reviewed, never run).
- The downgraded `react-native-gesture-handler` 3.3 on iOS (web smoke only).

## 5. Switch-off sequence for syscd's budget

1. In home-systems budget.yaml set `BUDGET_REPEAT_TICK` to `"1"` (or delete
   the env) on budget-api, and turn the tick off in syscd's own config.
2. Pluggy: point the webhook (dashboard, and existing items if they carry
   their own URL) at `https://budget-api.syscd.live/connections/webhook/pluggy`;
   fill `PLUGGY_*` in item `budget` if you left them empty in 2.2.
3. Job instance ids are already distinct (`prod` for syscd, `budget-prod` for
   budget, separate Temporal servers and namespaces), so in-flight job runs
   stay with the side that queued them.
4. Remove budget from syscd (migration-plan phase 7, needs its own approval).
   The `budget` database stays owned by `syscd`; transfer it with
   `ALTER DATABASE budget OWNER TO budget_app;` plus
   `REASSIGN OWNED BY syscd TO budget_app;` run inside `budget` only after
   syscd no longer uses it, and change the `budget` entry's `owner` in
   postgres.yaml in the same change.

## 5a. Switching sign-in to Cloudflare Access

Code is on `main` (decisions.md, "Access sign-in"); nothing is deployed or
created yet. Steps, in order:

1. Cloudflare Zero Trust > Access > Applications: add a self-hosted
   application for `budget-api.syscd.live/auth/access` (path `auth/access`
   covers `/auth/access/native` too) with the Admin policy (the e-mails
   allowed to use Budget). Everything else on `budget-api.syscd.live` stays
   bypassed, in particular `POST /auth/exchange` (the native app's code
   exchange, a plain fetch that cannot do a Cloudflare login).
2. Copy the application's AUD tag.
3. Set on the api (and worker, harmless) in item `budget`:
   `ACCESS_TEAM_DOMAIN=syscd.cloudflareaccess.com`, `ACCESS_AUD=<AUD tag>`
   (comma-separate a second tag if native gets its own application). Never
   set `ACCESS_CERTS_URL` in the cluster (the API refuses to boot).
4. Roll out and verify a real sign-in: open https://budget.syscd.live in a
   fresh browser; it should go to Cloudflare's login (or straight in with a
   live Access session) and land back signed in. `curl
   https://budget-api.syscd.live/auth/providers` shows `"access":true`.
   Also check the iOS app's "Sign in" and an MCP/CLI login (consent page).
5. Then remove `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
   `AUTH_ALLOWED_EMAILS` (keep the last one only if you want an API-side list
   on top of the policy) and roll out again.

Revoking someone later: remove them from the policy AND
`update public.users set status = 'disabled' where email = '...'` (their
current session otherwise lives until it expires).

## 6. Open follow-ups (`tk list`)

| Id | What |
|---|---|
| budget-u1n | Phase 6 deploy and cutover: this document |
| budget-ef9 | Align expo, @expo/ui, expo-file-system, expo-web-browser after 2026-11-19 12:00 UTC |
| budget-hd3 | API: treat empty Pluggy env values as unset |
| budget-59c | Move the repeat-rule tick to a Temporal schedule |
| budget-vyz | Output schemas for jobs and oauth contracts |
| budget-fys | Client UI for `accounts.currency` |
| budget-ows | Adopt the provider currency at bank-link time |
| budget-5rk | Client: remove the phase-5e re-export shims, move `budget/data` |
| budget-u7c | Client: split MoveMoneySheet and CategoryInspector under 600 lines |
| budget-65f | Client: 75 hex literals outside the theme |
| budget-dho | Inline add row defaults to a closed first account (pre-existing) |
| budget-rnn | Register category combobox creates a category in Credit Card Payments on Enter (pre-existing) |
| budget-qal | Tablet: settings menu fades in over the open drawer (pre-existing) |

Closed overnight after checking each is merged on `main`: phases 1 to 5e
(budget-xsp, -yue, -qps, -z1t, -sfa, -nwc, -vsy, -ku4, -dqt) and
budget-p00, -rxp, -njc, -xef, -xd6, -fwf, -ipa.

Left on disk: worktrees `.worktrees/budget-budget-{ku4,nwc,sfa}` (branches
merged, but each has uncommitted `.tasks` edits, so they were not removed).

## 7. Reference

- `docs/architecture.md`: layout and rules of each package.
- `docs/decisions.md`: every decision with its evidence ("Phase 6: deploy"
  for the cluster pieces).
- `docs/evidence/`: parity pass (`parity/REPORT.md`), phase 3, 5d and 5e
  screenshots.

### 7.1 Database access note (no action expected)

`budget_app` is a member of `syscd` (`inRoles`, inherit), so it can read,
write and run migrations on everything syscd owns in `budget`; no manual GRANT
is needed. Tables a future budget migration creates are owned by
`budget_app`, so syscd cannot see them; that is fine while syscd does not need
them. To make new objects visible to `syscd`, the one-off SQL (as a superuser,
inside `budget`) is
`ALTER DEFAULT PRIVILEGES FOR ROLE budget_app GRANT ALL ON TABLES TO syscd;`.
