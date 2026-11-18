# Morning list: budget deploy (phase 6)

Written 2026-11-18 by the deploy run. Everything below needs your accounts or
a decision; do it top to bottom. State at the time of writing is in
`docs/decisions.md` ("Phase 6: deploy").

What is already done: private repo https://github.com/yurifrl/budget, images
`ghcr.io/yurifrl/budget-{web,api,admin}:2026.11.18` (private, like syscd's),
home-systems `k8s/applications/budget.yaml` + `postgres.yaml` roles/DBs on
`main` (ArgoCD auto-syncs), Cloudflare Access entries for `budget-api`
(bypass) and `budget-admin` (Admin) in home-systems-values.

## 1. Run the 1Password script (nothing works until this is done)

`op` was not signed in overnight, so no 1Password item exists yet.

```sh
op signin --account my.1password.com
cd ~/Workdir/Yuri/budget
scripts/create-1password-item.sh          # OP_VAULT defaults to Kubernetes
```

It creates, in vault `Kubernetes` (the one the `onepassword`
ClusterSecretStore reads, where `syscd-app` lives):

| Item | Fields |
|---|---|
| `budget` | `DB_PASSWORD`, `DATABASE_URL`, `SESSION_SECRET` (generated); `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `AUTH_ALLOWED_EMAILS`, `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET`, `PLUGGY_SANDBOX`, `PLUGGY_WEBHOOK_SECRET`, `PLUGGY_ITEM_IDS`, `CLIENT_USER_ID`, `OT_SERVICE_TOKEN` (empty) |
| `budget-temporal` | `DB_PASSWORD` (generated) |
| `argocd-budget` | `sshPrivateKey` (generated); its public half is added to yurifrl/budget as a read-only deploy key |

`DATABASE_URL` is `postgres://budget_app:<DB_PASSWORD>@pg-rw.databases.svc.cluster.local:5432/budget`.
If syscd-app's own `DATABASE_URL` carries query parameters (e.g. `sslmode`),
add the same ones.

If the vault is named differently, run with `OP_VAULT=<name>`. If you prefer
the vault UI: same items, same field names; random values of 48+ chars.

Within ~1h (ExternalSecret refresh; or force it, see 8) this unblocks:
CNPG roles `budget_app` / `budget_temporal` get their passwords, the
`budget_temporal*` databases get created, Temporal starts (schema job, then
namespace job), and the worker boots. The API keeps crash-looping until step 2
(by design).

## 2. Fill the empty fields of item `budget`

| Field | Value | Copy from |
|---|---|---|
| `GOOGLE_CLIENT_ID` | OAuth client id | same as item `syscd-app` field `GOOGLE_CLIENT_ID` (reuse the client, step 3) |
| `GOOGLE_CLIENT_SECRET` | OAuth client secret | same as `syscd-app` `GOOGLE_CLIENT_SECRET` |
| `AUTH_ALLOWED_EMAILS` | comma-separated e-mails | same as `syscd-app` `AUTH_ALLOWED_EMAILS` |
| `PLUGGY_CLIENT_ID` | Pluggy client id | `syscd-app` `PLUGGY_CLIENT_ID`; **see the warning below** |
| `PLUGGY_CLIENT_SECRET` | Pluggy secret | `syscd-app` `PLUGGY_CLIENT_SECRET` |
| `PLUGGY_SANDBOX` | `false` in production (the code defaults to `true`) | `syscd-app` `PLUGGY_SANDBOX` |
| `PLUGGY_WEBHOOK_SECRET` | shared secret Pluggy sends | `syscd-app` `PLUGGY_WEBHOOK_SECRET` (must match what Pluggy sends) |
| `PLUGGY_ITEM_IDS` | optional | `syscd-app` `PLUGGY_ITEM_IDS` if set |
| `CLIENT_USER_ID` | optional, default `syscd-app` (keeps existing Pluggy items attached) | leave empty |
| `OT_SERVICE_TOKEN` | optional machine bearer; empty disables that lane | leave empty, or a new random 48+ char value |

The API boots once the Google pair, `AUTH_ALLOWED_EMAILS` and
`SESSION_SECRET` are set (api/src/auth-env.ts). Pods pick the values up on
their next restart after the secret syncs (envFrom): see 8.

Warning, Pluggy: both workers (syscd's and budget's) run the
`connections-sweep` schedule every 6 h against the same connections in the
shared `budget` database. Until syscd's budget is switched off (section 10),
consider leaving `PLUGGY_CLIENT_ID` / `PLUGGY_CLIENT_SECRET` empty in `budget`
so only syscd syncs banks.

## 3. Google OAuth console

Console > APIs & Services > Credentials > the OAuth client syscd uses (Web
application). Add to **Authorised redirect URIs**:

```
https://budget-api.syscd.live/auth/google/callback
https://budget-api.syscd.live/auth/google/native/callback
```

(`api/src/user/authz.ts`: web flow `/auth/google` -> `/auth/google/callback`;
native flow `/auth/google/native` -> `/auth/google/native/callback`.)
Authorised JavaScript origins: none needed (the flow is server-side
redirects, the client has no Google JS SDK). If the consent screen is in
"Testing", the allowed users already cover you.

## 4. Pluggy dashboard

Webhook URL for the new host (`api/src/connections/webhook.ts`, mounted under
`/connections`):

```
https://budget-api.syscd.live/connections/webhook/pluggy
```

The app never sends a `webhookUrl` when creating items, so the URL is the
one configured in the Pluggy dashboard/application. Existing Pluggy items
keep the old webhook (`https://api.syscd.live/connections/webhook/pluggy`):
leave it there while syscd's budget runs; switch it at turn-off (section 10).

## 5. Turn on the `$values` source (release auto-deploy)

After step 1 the `argocd-budget` repository secret appears in `argocd`
(check: `kubectl -n argocd get secret argocd-budget`). Then in home-systems
`k8s/applications/budget.yaml` uncomment both blocks:

```yaml
        valueFiles:
          - $values/k8s/values.yaml
...
    - repoURL: git@github.com:yurifrl/budget.git
      targetRevision: main
      ref: values
```

and commit to main. From then on `task release` (budget repo) rolls the
cluster by itself. Do not enable it before the secret exists: a source ArgoCD
cannot fetch breaks manifest generation for the whole Application. Until then
image tags are pinned inline (`2026.11.18`); to roll a new release by hand,
bump the four `tag:` values in budget.yaml.

## 6. Images: only if pods show ImagePullBackOff

The three GHCR packages are private, like syscd's (`syscd-app*`), which the
nodes pull with the ghcr.io registry auth in their Talos machineconfig
(nostos templates). If budget pods still show ImagePullBackOff, make them
public: https://github.com/users/yurifrl/packages/container/budget-web/settings
(and `budget-api`, `budget-admin`) > Danger Zone > Change visibility > Public.
GitHub's REST API has no endpoint for this.

## 7. Expo / EAS and App Store (not blocking the web deploy)

```sh
cd ~/Workdir/Yuri/budget/client
bunx eas-cli login
bunx eas-cli init                 # creates the EAS project for slug `budget`, owner yurifrl
bunx eas-cli build:configure      # creates eas.json (release.yml uses profile `production`)
```

- Put the printed projectId into `client/app.config.ts` `extra.eas.projectId`
  (the comment marks the spot) and commit eas.json.
- Expo token: https://expo.dev/settings/access-tokens, then
  `gh secret set EXPO_TOKEN --repo yurifrl/budget`.
- `gh secret set EXPO_APPLE_APP_SPECIFIC_PASSWORD --repo yurifrl/budget`
  (appleid.apple.com > App-Specific Passwords).
- `gh variable set EAS_ENABLED --body true --repo yurifrl/budget`.
- App Store Connect: new app, bundle id `live.syscd.budget` (register the
  identifier in developer.apple.com first, or let `eas build` do it), name
  "Budget". Android/Play: not now (D7), package is also `live.syscd.budget`.

## 8. Verify

```sh
curl -s https://budget-api.syscd.live/health    # {"ok":true,"version":"2026.11.18"}
curl -sI https://budget.syscd.live              # 302 to Cloudflare Access (like app.syscd.live), 200 after login
curl -sI https://budget-admin.syscd.live        # 302 to Cloudflare Access (Admin policy)
curl -s https://api.syscd.live/health           # syscd untouched
```

On the cluster:

```sh
kubectl -n argocd get application budget
kubectl -n budget get pods,externalsecrets
kubectl -n databases get externalsecret budget-app-db-roles budget-temporal-db-roles
kubectl -n databases get databases.postgresql.cnpg.io | grep budget
kubectl -n databases get cluster pg -o jsonpath='{.status.managedRolesStatus}'
kubectl -n budget logs deploy/budget-api | head     # FATAL: auth misconfiguration ... until step 2
```

Force a resync instead of waiting for the 1h refresh:
`kubectl -n budget annotate externalsecret budget force-sync=$(date +%s) --overwrite`
(same for `budget-temporal-db`, and the two `*-roles` in `databases`), then
`kubectl -n budget rollout restart deploy/budget-api deploy/budget-worker`.

Then sign in at https://budget.syscd.live, and check the admin at
https://budget-admin.syscd.live (Temporal UI: https://budget-temporal.syscd.tech, tailnet).

## 9. Roll back

1. home-systems: delete `k8s/applications/budget.yaml` and commit. The
   Application has the resources finalizer, so ArgoCD prunes the `budget`
   namespace's resources and the ExternalSecrets in `databases`/`argocd`.
2. home-systems `k8s/applications/postgres.yaml`: remove the `budget_app` and
   `budget_temporal` roles and the `budget_temporal` /
   `budget_temporal_visibility` databases. The databases have
   `databaseReclaimPolicy: retain`: removing the entries deletes the CNPG
   `Database` objects but keeps the Postgres databases; drop them by hand if
   wanted (`DROP DATABASE budget_temporal; DROP DATABASE budget_temporal_visibility;`).
   Roles: set `ensure: absent` first (CNPG drops the role), then remove the
   entry; a role that owns objects cannot be dropped (see the note in 11).
   Never touch the `budget` database entry or the `syscd` role.
3. home-systems-values `cloudflare-access/values.yaml`: remove `budget-api`
   and `budget-admin-live`.

## 10. Later: switch off syscd's budget

Order:
1. In budget.yaml set `BUDGET_REPEAT_TICK` to `"1"` (or delete the env) on
   budget-api, and turn the tick off on syscd (syscd's own config).
2. Pluggy: point the webhook (dashboard, and existing items if they carry
   their own URL) at `https://budget-api.syscd.live/connections/webhook/pluggy`;
   fill `PLUGGY_*` in item `budget` if left empty in step 2.
3. Job instance ids are already distinct (`prod` for syscd, `budget-prod` for
   budget; separate Temporal servers and namespaces), so in-flight job runs
   stay with the side that queued them.
4. Remove budget from syscd (migration-plan phase 7, needs its own approval).
   The `budget` database stays owned by `syscd`; transfer it with
   `ALTER DATABASE budget OWNER TO budget_app;` plus `REASSIGN OWNED BY syscd TO budget_app;`
   run inside `budget` only after syscd no longer uses it (and change the
   `budget` entry's `owner` in postgres.yaml in the same change).

## 11. Database access note (no action expected)

`budget_app` is a member of `syscd` (`inRoles`, inherit), so it can read,
write and run migrations on everything syscd owns in `budget`; no manual
GRANT is needed. Tables or schemas a future budget migration creates are
owned by `budget_app`, so syscd cannot see them; that is fine while syscd
does not need them. If you want new objects owned by `syscd` instead, the
one-off SQL (as a superuser, inside `budget`) would be
`ALTER DEFAULT PRIVILEGES FOR ROLE budget_app GRANT ALL ON TABLES TO syscd;`;
not required today.
