#!/usr/bin/env bash
# Create the 1Password items the cluster's `budget` Application reads
# (home-systems k8s/applications/budget.yaml), in one pass:
#
#   budget           app env (ExternalSecret `budget`, dataFrom extract) +
#                    DB_PASSWORD for the CNPG role budget_app
#   budget-temporal  DB_PASSWORD for the CNPG role budget_temporal (Temporal)
#   argocd-budget    sshPrivateKey: ArgoCD's read-only deploy key for the
#                    private yurifrl/budget repo (the public half is added to
#                    the repo with `gh repo deploy-key add`)
#
# Random values (SESSION_SECRET, both DB passwords, the SSH key) are generated
# here at run time and never printed or written to the repo. Account-bound
# values (Google, Pluggy, allow-list) are created EMPTY: fill them in the
# 1Password app afterwards (docs/MORNING.md says what goes where). Empty
# values count as unset in the API, so its auth guard keeps it from booting
# until they are filled.
#
# Idempotent: an item that already exists is left untouched (skipped).
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

exists() { op item get "$1" --vault "$OP_VAULT" >/dev/null 2>&1; }

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
  db_password="$(openssl rand -hex 24)"
  export V_DB_PASSWORD="$db_password"
  export V_DATABASE_URL="postgres://${PG_USER}:${db_password}@${PG_HOST}/${PG_DB}"
  export V_SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  # Left empty on purpose (filled by hand): GOOGLE_*, AUTH_ALLOWED_EMAILS,
  # PLUGGY_*, CLIENT_USER_ID, OT_SERVICE_TOKEN.
  create_item budget \
    DB_PASSWORD DATABASE_URL SESSION_SECRET \
    GOOGLE_CLIENT_ID GOOGLE_CLIENT_SECRET AUTH_ALLOWED_EMAILS \
    PLUGGY_CLIENT_ID PLUGGY_CLIENT_SECRET PLUGGY_SANDBOX PLUGGY_WEBHOOK_SECRET \
    PLUGGY_ITEM_IDS CLIENT_USER_ID OT_SERVICE_TOKEN
  unset V_DB_PASSWORD V_DATABASE_URL V_SESSION_SECRET db_password
fi

# ---- budget-temporal ------------------------------------------------------
if exists budget-temporal; then
  echo "item 'budget-temporal' already exists: skipped"
else
  export V_DB_PASSWORD="$(openssl rand -hex 24)"
  create_item budget-temporal DB_PASSWORD
  unset V_DB_PASSWORD
fi

# ---- argocd-budget (deploy key) --------------------------------------------
if exists argocd-budget; then
  echo "item 'argocd-budget' already exists: skipped (deploy key not touched)"
else
  ssh-keygen -q -t ed25519 -N '' -C "argocd@home-systems (yurifrl/budget, read-only)" -f "$tmp/argocd-budget"
  export V_sshPrivateKey="$(cat "$tmp/argocd-budget")"
  create_item argocd-budget sshPrivateKey
  unset V_sshPrivateKey
  # Read-only by default (no --allow-write).
  gh repo deploy-key add "$tmp/argocd-budget.pub" --repo "$REPO" --title "argocd (home-systems)"
  echo "added read-only deploy key to $REPO"
fi

echo "done. Next: fill the empty fields of item 'budget' (docs/MORNING.md)."
