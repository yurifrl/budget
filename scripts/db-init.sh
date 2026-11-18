#!/usr/bin/env bash
# Create (or recreate with --recreate) a budgetnew_* database and initialise it
# like api/db/dev-initdb.sh does for the compose Postgres: all migrations, the
# dev seed, then the seed-dependent 0010 data migration.
#
#   scripts/db-init.sh budgetnew_dev            # no-op if it already exists
#   scripts/db-init.sh budgetnew_e2e --recreate
#
# Needs `psql` (override with PSQL=...) and a Postgres reachable as
# postgres:postgres on localhost:5432 (PGHOST/PGPORT/PGUSER/PGPASSWORD override).
# Refuses any database name that does not start with budgetnew_.
set -euo pipefail

db="${1:?usage: db-init.sh <budgetnew_db> [--recreate]}"
recreate="${2:-}"
case "$db" in budgetnew_[a-z0-9_]*) ;; *) echo "refusing database '$db': must match budgetnew_*" >&2; exit 1 ;; esac

root="$(cd "$(dirname "$0")/.." && pwd)"
psql_bin="${PSQL:-psql}"
export PGHOST="${PGHOST:-localhost}" PGPORT="${PGPORT:-5432}" PGUSER="${PGUSER:-postgres}" PGPASSWORD="${PGPASSWORD:-postgres}"
sql() { "$psql_bin" -v ON_ERROR_STOP=1 -q -d "$1" "${@:2}"; }

if [ "$recreate" = "--recreate" ]; then
  sql postgres -c "drop database if exists $db" >/dev/null
fi
if [ "$(sql postgres -Atc "select 1 from pg_database where datname = '$db'")" = "1" ]; then
  echo "db-init: $db already exists, leaving it as is"
  exit 0
fi
sql postgres -c "create database $db" >/dev/null

for f in "$root"/api/db/migrations/*.sql; do
  case "$f" in */0010_*) continue ;; esac
  sql "$db" < "$f" >/dev/null
done
sql "$db" < "$root/api/db/seed/seed.sql" >/dev/null
sql "$db" < "$root"/api/db/migrations/0010_*.sql >/dev/null
echo "db-init: $db ready"
