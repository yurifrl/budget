/**
 * Bun test preload: point DATABASE_URL at the throwaway per-checkout `budgetnew_test[_hash]`
 * database so DB-backed tests never pollute the dev database.
 *
 * Bootstrap order:
 *   1. apply db/migrations/*.sql (schema_migrations-tracked, like migrate.ts)
 *   2. if a migration fails (0010 is a seed-data migration and needs rows),
 *      apply db/seed/*.sql once and retry it
 *
 * On any failure the original DATABASE_URL is restored and this module
 * imports NOTHING from `src/` — the regular tests then hit the dev DB
 * or skip, exactly as before this preload existed.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const DEV_DATABASE_URL = process.env.DATABASE_URL ?? '';

/**
 * One throwaway DB per checkout, so parallel worktrees/agents sharing the dev
 * Postgres (:5432) never drop each other's DB mid-run:
 *   - BUDGET_TEST_DB=<name>        explicit override (letters/digits/_ only)
 *   - linked git worktree         budgetnew_test_<8-char sha1 of the repo root>
 *   - main checkout / CI          budgetnew_test
 * Stale ones: psql -h localhost -U postgres -Atc "select datname from
 * pg_database where datname like 'budgetnew_test_%'" (drop what you own).
 */
function testDbName(): string {
  const override = process.env.BUDGET_TEST_DB;
  if (override) {
    // Only ever drop databases this repo owns: the shared Postgres also holds
    // syscd's `budget` / `budget_test*` databases.
    if (!/^budgetnew_test[a-z0-9_]{0,48}$/.test(override)) {
      throw new Error(`[test-db] invalid BUDGET_TEST_DB "${override}" (must match budgetnew_test[a-z0-9_]*)`);
    }
    return override;
  }
  // Repo root (api/ sits one level below it).
  const root = join(import.meta.dir, '..', '..');
  // A linked worktree has a `.git` *file*; the main checkout has a directory.
  const linked = statSync(join(root, '.git'), { throwIfNoEntry: false })?.isFile() ?? false;
  if (!linked) return 'budgetnew_test';
  return `budgetnew_test_${createHash('sha1').update(root).digest('hex').slice(0, 8)}`;
}

const TEST_DB = testDbName();
/** Override to point at a private Postgres (e.g. a worktree's own container on another port). */
const PG_BASE = process.env.BUDGET_TEST_PG_BASE ?? 'postgres://postgres:postgres@localhost:5432';
const TEST_DATABASE_URL = `${PG_BASE}/${TEST_DB}`;
const MAINTENANCE_URL = `${PG_BASE}/postgres`;

/**
 * CI sets BUDGET_REQUIRE_TEST_DB=1 so an unavailable test database fails the
 * run instead of silently skipping every DB-backed suite. Unset locally.
 */
const REQUIRED = process.env.BUDGET_REQUIRE_TEST_DB === '1';

function fatalIfRequired(reason: string): void {
  if (REQUIRED) throw new Error(`[test-db] BUDGET_REQUIRE_TEST_DB=1 but ${reason}`);
}

function isolationAvailable(): boolean {
  return DEV_DATABASE_URL !== TEST_DATABASE_URL;
}

/** Recreates the throwaway DB so every run starts from a clean slate. */
async function recreateTestDb(): Promise<void> {
  if (!TEST_DB.startsWith('budgetnew_test')) throw new Error(`[test-db] refusing to drop ${TEST_DB}`);
  const client = new pg.Client({ connectionString: MAINTENANCE_URL });
  await client.connect();
  try {
    await client.query(`drop database if exists ${TEST_DB} with (force)`);
    await client.query(`create database ${TEST_DB}`);
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function reachable(client: pg.Client): Promise<boolean> {
  try {
    await client.query('select 1');
    return true;
  } catch {
    return false;
  }
}

async function appliedFiles(client: pg.Client): Promise<Set<string>> {
  await client.query(
    'create table if not exists schema_migrations (filename text primary key)',
  );
  const result = await client.query<{ filename: string }>(
    'select filename from schema_migrations',
  );
  return new Set(result.rows.map((row) => row.filename));
}

interface SqlStep {
  file: string;
  sql: string;
  /** Seed files run in the transaction but never enter schema_migrations. */
  isSeed: boolean;
}

async function bootstrap(
  client: pg.Client,
  migrationsDir: string,
  seedDir: string,
): Promise<void> {
  const applied = await appliedFiles(client);
  const pending: SqlStep[] = [
    ...readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .filter((f) => !applied.has(f))
      .sort()
      .map((file) => ({ file, sql: readFileSync(join(migrationsDir, file), 'utf8'), isSeed: false })),
    ...['seed.sql'].map((file) => ({
      file: `seed/${file}`,
      sql: readFileSync(join(seedDir, file), 'utf8'),
      isSeed: true,
    })),
  ];

  // Migration order is not linear on a fresh DB: data migrations (0010) need
  // seed rows while seed.sql needs schema from later migrations (0013's
  // owner_user_id). Retry failed steps each pass; hard-fail only when a full
  // pass makes no progress.
  while (pending.length > 0) {
    const progress: string[] = [];
    let lastError: unknown;

    for (const step of pending) {
      try {
        await client.query('begin');
        await client.query(step.sql);
        if (!step.isSeed) {
          await client.query('insert into schema_migrations (filename) values ($1)', [step.file]);
        }
        await client.query('commit');
        progress.push(step.file);
      } catch (err) {
        await client.query('rollback');
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (progress.length === 0) {
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    }
    const done = new Set(progress);
    for (let i = pending.length - 1; i >= 0; i--) {
      if (done.has(pending[i]!.file)) pending.splice(i, 1);
    }
  }
}

export async function setup(): Promise<void> {
  if (!isolationAvailable()) {
    fatalIfRequired(`DATABASE_URL already points at ${TEST_DB}; isolation unavailable`);
    return;
  }

  const seedDir = join(import.meta.dir, '..', 'db', 'seed');
  const migrationsDir = join(import.meta.dir, '..', 'db', 'migrations');
  let lastError: unknown;
  for (const _attempt of [0]) {
    try {
      await recreateTestDb();
      const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
      try {
        await client.connect();
        if (await reachable(client)) {
          await bootstrap(client, migrationsDir, seedDir);
          process.env.DATABASE_URL = TEST_DATABASE_URL;
          // Suites that full-table-wipe (user/) must never run against a
          // shared dev DB; they gate on this marker and skip when absent.
          process.env.BUDGET_TEST_DB_ISOLATED = '1';
          return;
        }
        // Unreachable test DB → keep dev env; DB-backed tests skip as before.
        fatalIfRequired('the test database is unreachable');
        return;
      } finally {
        await client.end().catch(() => undefined);
      }
    } catch (err) {
      lastError = err;
    }
  }

  console.warn(
    `[test-db] isolation unavailable (${lastError instanceof Error ? lastError.message : String(lastError)}); DB-backed tests will skip`,
  );
  fatalIfRequired(`isolation failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  process.env.DATABASE_URL = DEV_DATABASE_URL;
}

await setup();
