import { pool } from './db';

/**
 * DB-backed-suite gate: true only when the bun test preload re-pointed
 * DATABASE_URL at the throwaway per-checkout `budgetnew_test[_hash]` database (the isolation marker
 * it sets) and the pool answers. Suites that full-table-wipe (e.g. every
 * row in public.users) MUST gate on this — against a shared dev database the
 * wipes would destroy real data through the users-cascade.
 */
export const dbReady: boolean =
  process.env.BUDGET_TEST_DB_ISOLATED === '1' &&
  (await pool
    .query('select 1')
    .then(() => true)
    .catch(() => false));

// CI (BUDGET_REQUIRE_TEST_DB=1): a DB-backed suite must never skip silently.
if (process.env.BUDGET_REQUIRE_TEST_DB === '1' && !dbReady) {
  throw new Error('[test-gate] BUDGET_REQUIRE_TEST_DB=1 but the isolated test DB is not ready');
}
