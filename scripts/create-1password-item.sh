#!/usr/bin/env bash
# Create the ONE 1Password item the cluster's `budget` Application reads
# (home-systems k8s/applications/budget.yaml): item `budget`, holding
#
#   the app env             (ExternalSecret `budget`, dataFrom extract), incl.
#                           DB_PASSWORD for the CNPG role budget_app
#   TEMPORAL_DB_PASSWORD    password of the CNPG role budget_temporal
#   ARGOCD_SSH_PRIVATE_KEY  ArgoCD's read-only deploy key for the private
#                           yurifrl/budget repo (the public half is added to
#                           the repo with `gh repo deploy-key add`)
#
# Random values (SESSION_SECRET, both DB passwords, the SSH key) are generated
# here at run time and never printed or written to the repo. Account-bound
# values (Google, Pluggy, allow-list) are created EMPTY: fill them in the
# 1Password app afterwards (docs/MORNING.md says what goes where). Empty
# Google/allow-list values count as unset in the API, so its auth guard keeps
# it from booting until they are filled. PLUGGY_SANDBOX is created as `false`
# (production). CLIENT_USER_ID is NOT created: the Pluggy env schema takes an
# empty string literally (it would replace the `syscd-app` default with "");
# add the field only to override that default.
#
# Idempotent: an item whose title already exists in the vault is left
# untouched (skipped). If `op` cannot list the vault, or a title matches more
# than one item, the script stops before creating anything.
#
# Usage: scripts/create-1password-item.sh
#   OP_ACCOUNT  default my.1password.com
#   OP_VAULT    default Kubernetes (the vault the ClusterSecretStore reads)
set -euo pipefail

OP_ACCOUNT="${OP_ACCOUNT:-my.1password.com}"
OP_VAULT="${OP_VAULT:-Kubernetes}"
REPO="yurifrl/budget"
# In-cluster Postgres: CNPG cluster `pg`, read-write service, database `budget`.
PG_HOST="pg-rw.databases.svc.cluster.local:5432"
PG_DB="budget"
PG_USER="budget_app"

for bin in op openssl ssh-keygen gh python3; do
  command -v "$bin" >/dev/null || { echo "missing: $bin" >&2; exit 1; }
done

op() { command op --account "$OP_ACCOUNT" "$@"; }

op vault get "$OP_VAULT" >/dev/null || { echo "vault '$OP_VAULT' not found in $OP_ACCOUNT (set OP_VAULT)" >&2; exit 1; }

tmp="$(mktemp -d)"
chmod 700 "$tmp"
trap 'rm -rf "$tmp"' EXIT

# Exact-title lookup over the vault listing (titles only, no secret values).
# Errors from `op` abort the script instead of reading as "missing", so a
# transient failure can never create a duplicate item.
titles="$(op item list --vault "$OP_VAULT" --format json | python3 -c 'import json,sys; print("\n".join(i.get("title","") for i in json.load(sys.stdin)))')"
exists() {
  local n
  n="$(printf '%s\n' "$titles" | grep -cxF -- "$1" || true)"
  if [ "$n" -gt 1 ]; then
    echo "vault '$OP_VAULT' has $n items titled '$1'; resolve by hand first" >&2
    exit 1
  fi
  [ "$n" -eq 1 ]
}
exists budget || true

# Build a Secure Note template from NAME=VALUE pairs (VALUE may be empty) and
# create the item. Every field is CONCEALED. Values are passed through env
# vars to python, never on a command line.
create_item() {
  local title="$1"; shift
  local file="$tmp/$title.json"
  ITEM_TITLE="$title" python3 - "$@" >"$file" <<'PY'
import json, os, sys
fields = []
for name in sys.argv[1:]:
    fields.append({"id": name, "label": name, "type": "CONCEALED",
                   "value": os.environ.get("V_" + name, "")})
print(json.dumps({"title": os.environ["ITEM_TITLE"], "category": "SECURE_NOTE",
                  "fields": fields}))
PY
  chmod 600 "$file"
  op item create --vault "$OP_VAULT" --template "$file" >/dev/null
  echo "created item '$title' in vault '$OP_VAULT' (fields: $*)"
}

# ---- budget ---------------------------------------------------------------
if exists budget; then
  echo "item 'budget' already exists: skipped"
else
  # Assign first, export after: `export X="$(cmd)"` would hide a failing cmd
  # from `set -e` and store an empty secret.
  db_password="$(openssl rand -hex 24)"
  session_secret="$(openssl rand -base64 48 | tr -d '\n')"
  [ -n "$db_password" ] && [ -n "$session_secret" ] || { echo "random generation failed" >&2; exit 1; }
  export V_DB_PASSWORD="$db_password"
  export V_DATABASE_URL="postgres://${PG_USER}:${db_password}@${PG_HOST}/${PG_DB}"
  export V_SESSION_SECRET="$session_secret"
  export V_PLUGGY_SANDBOX="false"
  temporal_password="$(openssl rand -hex 24)"
  [ -n "$temporal_password" ] || { echo "random generation failed" >&2; exit 1; }
  export V_TEMPORAL_DB_PASSWORD="$temporal_password"
  ssh-keygen -q -t ed25519 -N '' -C "argocd@home-systems (yurifrl/budget, read-only)" -f "$tmp/argocd-budget"
  ssh_key="$(cat "$tmp/argocd-budget")"
  export V_ARGOCD_SSH_PRIVATE_KEY="$ssh_key"
  # Left empty on purpose (filled by hand): GOOGLE_*, AUTH_ALLOWED_EMAILS,
  # PLUGGY_CLIENT_ID/SECRET, PLUGGY_WEBHOOK_SECRET, PLUGGY_ITEM_IDS,
  # OT_SERVICE_TOKEN (empty = lane disabled).
  create_item budget \
    DB_PASSWORD DATABASE_URL SESSION_SECRET \
    GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET AUTH_ALLOWED_EMAILS \
    PLUGGY_CLIENT_ID PLUGGY_CLIENT_SECRET PLUGGY_SANDBOX PLUGGY_WEBHOOK_SECRET \
    PLUGGY_ITEM_IDS OT_SERVICE_TOKEN \
    TEMPORAL_DB_PASSWORD ARGOCD_SSH_PRIVATE_KEY
  unset V_DB_PASSWORD V_DATABASE_URL V_SESSION_SECRET V_PLUGGY_SANDBOX db_password session_secret
  unset V_TEMPORAL_DB_PASSWORD V_ARGOCD_SSH_PRIVATE_KEY temporal_password ssh_key
  new_item=1
fi

# ---- deploy key (public half of ARGOCD_SSH_PRIVATE_KEY) --------------------
# Read-only by default (no --allow-write). Only when the item was created in
# this run; an existing item's key is never touched.
if [ "${new_item:-0}" = 1 ]; then
  if gh repo deploy-key add "$tmp/argocd-budget.pub" --repo "$REPO" --title "argocd (home-systems)"; then
    echo "added read-only deploy key to $REPO"
  else
    echo "deploy key NOT added. Add it by hand (prints only the public key):" >&2
    echo "  op read --account $OP_ACCOUNT --out-file k 'op://$OP_VAULT/budget/ARGOCD_SSH_PRIVATE_KEY' && ssh-keygen -y -f k > k.pub && rm k && gh repo deploy-key add k.pub --repo $REPO --title 'argocd (home-systems)' && rm k.pub" >&2
    exit 1
  fi
fi

echo "done. Next: fill the empty fields of item 'budget' (docs/MORNING.md)."
