import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { pool, withTransaction } from './db';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'db', 'migrations');

/**
 * Signature probe per migration, used to detect tracking rows that lie —
 * rows present in schema_migrations for a file that never actually ran (the
 * pre-runner blanket baseline marked every file once `public.transactions`
 * existed; init flows drift, e.g. 0017 was added after the volume init).
 * The probe proves the file's own schema exists. Tracked + probe absent →
 * unmark and re-run, healing the gap.
 *
 * Every migration that creates or alters schema MUST have a probe (enforced
 * by migrate.test.ts): without one, a database that has the schema but no
 * tracking rows (db/dev-initdb.sh applies every file and writes none; a
 * restore from a schema dump; lost rows) re-runs the SQL at boot and dies on
 * "already exists". The only exemptions are MIGRATION_EXEMPT below.
 *
 * Format: `table:<schema>.<table>`, `index:<schema>.<index>`,
 * `column:<schema>.<table>.<column>`, or `absent:<schema>.<table>` (the probe
 * is the object's non-existence — e.g. a schema that was dropped). Column
 * probes where the migration only ALTERs an existing table. A list of probes
 * means every one must be present (a file creating several objects).
 */
const MIGRATION_SIGNATURES: Record<string, string | readonly string[]> = {
  '0001_budget_schema.sql': 'table:public.transactions',
  '0003_payees.sql': 'table:public.payees',
  '0004_ynab_compat.sql': 'table:public.subtransactions',
  '0005_health_schema.sql': 'table:public.food_catalog',
  '0006_ourtube_schema.sql': 'table:public.videos',
  // Not payee_rename_rules: 0016 drops that table, so the probe would fail on a
  // fresh dev DB and 0007 would re-run, resurrecting the dropped table.
  '0007_payee_domain.sql': 'column:public.payees.categorization_mode',
  '0008_category_targets.sql': 'table:public.category_targets',
  '0009_category_notes.sql': 'table:public.category_notes',
  '0011_repeat_rules.sql': 'table:public.txn_repeat_rules',
  '0012_users.sql': 'table:public.users',
  '0013_budget_ownership.sql': 'column:public.budgets.owner_user_id',
  '0014_connections.sql': 'table:public.connections',
  '0016_payee_rename_rule.sql': 'column:public.payees.rename_match_type',
  '0017_category_target_snooze.sql': 'column:public.category_targets.snooze_month',
  '0017_poll_state.sql': 'table:public.poll_state',
  '0018_health_catalog_v2.sql': 'table:public.food_catalog_source_state',
  '0019_health_user_fk.sql': 'absent:auth.users',
  '0020_budget_archived_at.sql': 'column:public.budgets.archived_at',
  '0021_account_link_unique.sql': 'index:public.accounts_link_unique',
  '0022_app_settings.sql': 'table:public.app_settings',
  '0023_budget_members.sql': 'table:public.budget_members',
  '0024_account_person.sql': 'column:public.accounts.user_id',
  '0025_oauth.sql': 'table:public.oauth_refresh_tokens',
  '0026_user_avatar.sql': 'table:public.user_avatars',
  '0027_connection_sync_window.sql': 'column:public.connections.sync_window_days',
  '0028_category_person.sql': 'column:public.categories.user_id',
  '0029_placeholder_people.sql': 'index:public.users_placeholder_idx',
  '0030_jobs.sql': 'table:jobs.job_runs',
  '0031_connection_status_message.sql': 'column:public.connections.status_message',
  '0032_category_bundles.sql': 'table:public.category_bundles',
  '0033_budget_revision.sql': 'column:public.budgets.revision',
  '0100_account_currency.sql': 'column:public.accounts.currency',
  '0101_multi_user.sql': 'column:public.users.signed_in_at',
  '0102_password_login.sql': ['table:public.user_passwords', 'table:public.auth_login_throttle'],
  '0103_feature_overrides.sql': 'table:public.feature_overrides',
};

/**
 * Pure data migrations: no schema to probe, and idempotent by construction
 * (`on conflict do nothing` / guarded updates), so re-running them when
 * untracked is harmless and recording them by execution is correct.
 *  - 0010: guarded renames + `on conflict do nothing` over the seeded Casa
 *    budget (dev-initdb.sh runs it after the seeds).
 *  - 0015: regexp rewrite of import_id that never matches its own output.
 */
export const MIGRATION_EXEMPT: Record<string, string> = {
  '0010_ynab_parity_plan_data.sql': 'data migration, on-conflict idempotent',
  '0015_import_key_payee.sql': 'data migration, rewrite never matches its own output',
};
export { MIGRATION_SIGNATURES };

/** Serializes concurrent runners (two API pods booting together). */
const MIGRATE_LOCK_KEY = 7_204_001;

async function signaturePresent(signature: string | readonly string[]): Promise<boolean> {
  if (typeof signature !== 'string') {
    for (const one of signature) if (!(await signaturePresent(one))) return false;
    return true;
  }
  const kindIndex = signature.indexOf(':');
  const kind = signature.slice(0, kindIndex);
  const target = signature.slice(kindIndex + 1);
  if (kind === 'table' || kind === 'index' || kind === 'absent') {
    const { rows } = await pool.query<{ t: string | null }>('select to_regclass($1) as t', [target]);
    const exists = rows[0].t !== null;
    return kind === 'absent' ? !exists : exists;
  }
  const [schema, table, column] = target.split('.');
  const { rowCount } = await pool.query(
    'select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and column_name = $3',
    [schema, table, column],
  );
  return rowCount === 1;
}

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * Apply any db/migrations/*.sql not yet recorded in schema_migrations, in
 * filename order, each in its own transaction. Idempotent across restarts:
 * non-idempotent statements (0004's renames) run exactly once because applied
 * files are tracked. Safe to call on every boot.
 */
export async function runMigrations(): Promise<void> {
  // Session-level advisory lock on a dedicated connection: a second runner
  // blocks here until the first finishes, then sees its tracking rows.
  const lock = await pool.connect();
  try {
    await lock.query('select pg_advisory_lock($1)', [MIGRATE_LOCK_KEY]);
    await applyMigrations();
  } finally {
    await lock.query('select pg_advisory_unlock($1)', [MIGRATE_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}

async function applyMigrations(): Promise<void> {
  await pool.query(
    'create table if not exists schema_migrations (filename text primary key, applied_at timestamptz not null default now())',
  );
  const { rows } = await pool.query<{ filename: string }>('select filename from schema_migrations');
  const applied = new Set(rows.map((r) => r.filename));

  // Signature-verify tracked rows, then baseline an untracked (legacy) DB.
  //  - a tracked row whose probe fails was marked by the old blanket baseline
  //    (it keyed on `public.transactions` alone, silently skipping files added
  //    after the DB was seeded) — unmark it so the migration re-runs and heals;
  //  - an untracked legacy DB gets each listed file marked only when its own
  //    signature already exists. Unlisted (guarded) files stay unmarked
  //    deliberately: they re-run harmlessly and fill any gaps (e.g. a
  //    seed-only DB missing the health tables).
  for (const file of migrationFiles()) {
    const signature = MIGRATION_SIGNATURES[file];
    if (signature === undefined) continue;
    const present = await signaturePresent(signature);
    if (applied.has(file) && !present) {
      await pool.query('delete from schema_migrations where filename = $1', [file]);
      applied.delete(file);
      console.log(`migration ${file}: tracked but signature absent — re-running`);
    } else if (!applied.has(file) && present) {
      await pool.query(
        'insert into schema_migrations (filename) values ($1) on conflict do nothing',
        [file],
      );
      applied.add(file);
    }
  }

  for (const file of migrationFiles()) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await withTransaction(pool, async (client) => {
        await client.query(sql);
        await client.query('insert into schema_migrations (filename) values ($1)', [file]);
      });
      console.log(`migrated ${file}`);
    } catch (err) {
      throw new Error(`migration ${file} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
