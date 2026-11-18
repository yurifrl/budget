#!/bin/bash
set -euo pipefail

# DEV-ONLY database initialization for docker-compose.yml. Runs as the single
# /docker-entrypoint-initdb.d/0000_stage.sh script on a fresh volume and applies
# everything in the order the app's seeds require:
#
#   1. db/migrations/*.sql in filename order (the schema source; there is no
#      0002)
#   2. db/seed/seed.sql (fake budget data; the health seed stayed in syscd)
#   3. 0010_ynab_parity_plan_data.sql — a DATA migration over the seeded Casa
#      budget, so it must run AFTER the seeds, out of its natural position
#
# schema_migrations rows are intentionally not written: the server's
# migration runner (api/src/core/migrate.ts) reconciles tracked files via
# signature probes on first startup, and the unlisted data migrations
# (0010, 0015) re-run harmlessly.

log() { echo "initdb: $*"; }

apply() {
  log "applying $1"
  psql -v ON_ERROR_STOP=1 -U postgres -d "${POSTGRES_DB:-budgetnew_dev}" -f "$1" >/dev/null
}

for f in /db-migrations/*.sql; do
  # 0010 inserts rows FK'd to the seeded Casa budget — defer to post-seed.
  case "$f" in */0010_*) log "deferring $f (post-seed)"; continue ;; esac
  apply "$f"
done

log "seeding"
apply /db-seed/seed.sql

apply /db-migrations/0010_ynab_parity_plan_data.sql
log "done"
