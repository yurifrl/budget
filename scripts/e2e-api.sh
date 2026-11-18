#!/usr/bin/env bash
# API end-to-end checks that need no Temporal: boots the API with auth ON
# against a freshly initialised database and runs api/scripts/e2e-mcp.ts in
# http mode (DCR + PKCE + consent, then the MCP tools over /mcp).
#
# Used by .github/workflows/ci.yml; runnable locally. Needs `psql` (override
# with PSQL=...), bun, and a Postgres reachable as postgres:postgres on
# localhost:5432 (PGHOST/PGPORT/PGPASSWORD override). The database must match
# budgetnew_* (default budgetnew_e2e) and is dropped first and again at exit.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
db="${E2E_DB:-budgetnew_e2e}"
port="${E2E_API_PORT:-3190}"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
psql_bin="${PSQL:-psql}"

case "$db" in budgetnew_*) ;; *) echo "refusing database '$db': must start with budgetnew_" >&2; exit 1 ;; esac

pg() { "$psql_bin" -v ON_ERROR_STOP=1 -q -d postgres -c "$1" >/dev/null; }

server_pid=""
cleanup() {
  if [ -n "$server_pid" ]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
  pg "drop database if exists $db" || true
}
trap cleanup EXIT

"$root/scripts/db-init.sh" "$db" --recreate >/dev/null

secret="e2e-session-secret-0123456789abcdef0123456789"
export DATABASE_URL="postgres://$PGUSER:$PGPASSWORD@$PGHOST:$PGPORT/$db"
export API_PORT="$port" BUDGET_API_URL="http://localhost:$port"
export AUTH_ALLOWED_EMAILS="e2e@budget.test" GOOGLE_CLIENT_ID="e2e" GOOGLE_CLIENT_SECRET="e2e" SESSION_SECRET="$secret"
export API_BASE_URL="http://localhost:$port" APP_BASE_URL="http://localhost:$port"
export E2E_EMAIL="e2e@budget.test" JOBS_INSTANCE_ID="budget-e2e"
export E2E_BUDGET_ID="aaaaaaaa-0000-0000-0000-000000000001" E2E_ACCOUNT_ID="33333333-0000-0000-0000-000000000001"

cd "$root/api"
bun src/index.ts > "${TMPDIR:-/tmp}/budget-e2e-api.log" 2>&1 &
server_pid=$!
for _ in $(seq 1 60); do
  curl -fsS "http://localhost:$port/health" >/dev/null 2>&1 && break
  kill -0 "$server_pid" 2>/dev/null || { cat "${TMPDIR:-/tmp}/budget-e2e-api.log"; echo "API exited early" >&2; exit 1; }
  sleep 1
done
curl -fsS "http://localhost:$port/health" >/dev/null

bun scripts/e2e-mcp.ts http
