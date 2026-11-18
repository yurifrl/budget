#!/usr/bin/env bash
# One-off: fold the items `budget-temporal` and `argocd-budget` (created by the
# first version of create-1password-item.sh) into the single item `budget`:
#
#   budget-temporal / DB_PASSWORD    -> budget / TEMPORAL_DB_PASSWORD
#   argocd-budget   / sshPrivateKey  -> budget / ARGOCD_SSH_PRIVATE_KEY
#
# Values go from `op read` into a JSON template on a private temp dir and are
# never printed. The two old items are NOT archived here: check `budget` in
# the app, then archive them yourself (or pass --archive).
#
# Usage: scripts/merge-1password-items.sh [--archive]
#   OP_ACCOUNT default my.1password.com, OP_VAULT default Kubernetes
set -euo pipefail

OP_ACCOUNT="${OP_ACCOUNT:-my.1password.com}"
OP_VAULT="${OP_VAULT:-Kubernetes}"
op() { command op --account "$OP_ACCOUNT" "$@"; }

tmp="$(mktemp -d)"; chmod 700 "$tmp"; trap 'rm -rf "$tmp"' EXIT

op read --out-file "$tmp/temporal" "op://$OP_VAULT/budget-temporal/DB_PASSWORD" >/dev/null
op read --out-file "$tmp/key" "op://$OP_VAULT/argocd-budget/sshPrivateKey" >/dev/null
[ -s "$tmp/temporal" ] && [ -s "$tmp/key" ] || { echo "a source field is empty; nothing changed" >&2; exit 1; }

op item get budget --vault "$OP_VAULT" --format json >"$tmp/budget.json"
python3 - "$tmp" <<'PY'
import json, sys
tmp = sys.argv[1]
item = json.load(open(f"{tmp}/budget.json"))
new = {"TEMPORAL_DB_PASSWORD": open(f"{tmp}/temporal").read().strip("\n"),
       "ARGOCD_SSH_PRIVATE_KEY": open(f"{tmp}/key").read().rstrip("\n") + "\n"}
fields = [f for f in item.get("fields", []) if f.get("label") not in new]
for label, value in new.items():
    fields.append({"id": label, "label": label, "type": "CONCEALED", "value": value})
item["fields"] = fields
json.dump(item, open(f"{tmp}/new.json", "w"))
PY
chmod 600 "$tmp/new.json"
op item edit budget --vault "$OP_VAULT" --template "$tmp/new.json" >/dev/null
echo "item 'budget' now has TEMPORAL_DB_PASSWORD and ARGOCD_SSH_PRIVATE_KEY"

if [ "${1:-}" = "--archive" ]; then
  op item delete budget-temporal --vault "$OP_VAULT" --archive
  op item delete argocd-budget --vault "$OP_VAULT" --archive
  echo "archived 'budget-temporal' and 'argocd-budget'"
else
  echo "check item 'budget', then archive 'budget-temporal' and 'argocd-budget'"
fi
