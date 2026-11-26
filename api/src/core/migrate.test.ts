import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'bun:test';
import pg, { type Pool } from 'pg';

import { pool } from './db';
import { MIGRATION_EXEMPT, MIGRATION_SIGNATURES, runMigrations } from './migrate';

const MIGRATIONS_DIR = join(import.meta.dir, '..', '..', 'db', 'migrations');
const migrationFiles = (): string[] => readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
/** The same server as `url`, database `name`. */
const databaseUrl = (url: string, name: string): string => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let reachable = true;
try {
  await pool.query('select 1');
} catch {
  reachable = false;
}

describe.skipIf(!reachable)('runMigrations', () => {
  it('is idempotent: applies all migrations, second run is a no-op', async () => {
    await runMigrations();
    const first = await pool.query('select count(*)::int as n from schema_migrations');
    expect(first.rows[0].n).toBeGreaterThan(0);

    // Core tables from the migrations must exist afterwards.
    const t = await pool.query(
      "select to_regclass('public.videos') as v, to_regclass('public.transactions') as x",
    );
    expect(t.rows[0].v).not.toBeNull();
    expect(t.rows[0].x).not.toBeNull();

    await runMigrations();
    const second = await pool.query('select count(*)::int as n from schema_migrations');
    expect(second.rows[0].n).toBe(first.rows[0].n);
  });

  it('recovers when schema exists but tracking rows are lost (dev-initdb.sh, restore from dump)', async () => {
    await runMigrations();
    const full = await pool.query('select count(*)::int as n from schema_migrations');
    // dev-initdb.sh applies every file but writes no schema_migrations rows.
    await pool.query('delete from schema_migrations');

    await runMigrations(); // must not throw "relation ... already exists"

    const after = await pool.query<{ filename: string }>('select filename from schema_migrations');
    expect(after.rowCount).toBe(full.rows[0].n);
  });

  it('every migration file has a signature probe or an explicit exemption', () => {
    const files = readdirSync(join(import.meta.dir, '..', '..', 'db', 'migrations'))
      .filter((f) => f.endsWith('.sql'));
    const missing = files.filter((f) => !(f in MIGRATION_SIGNATURES) && !(f in MIGRATION_EXEMPT));
    expect(missing).toEqual([]);
    const stale = [...Object.keys(MIGRATION_SIGNATURES), ...Object.keys(MIGRATION_EXEMPT)].filter(
      (f) => !files.includes(f),
    );
    expect(stale).toEqual([]);
    expect(Object.keys(MIGRATION_SIGNATURES).filter((f) => f in MIGRATION_EXEMPT)).toEqual([]);
  });

  describe('0127 drops ai_credentials for good', () => {
    const SQL_0109 = readFileSync(join(MIGRATIONS_DIR, '0109_ai_credentials.sql'), 'utf8');
    const tableExists = async (db: Pool = pool): Promise<boolean> =>
      (await db.query<{ t: string | null }>("select to_regclass('public.ai_credentials') as t")).rows[0].t !== null;
    const tracked = async (db: Pool = pool): Promise<string[]> =>
      (await db.query<{ filename: string }>('select filename from schema_migrations')).rows.map((r) => r.filename).sort();

    it('a brand-new empty database ends with no ai_credentials and every migration recorded; a rerun changes nothing', async () => {
      const base = process.env.DATABASE_URL ?? '';
      // Only on the preload's throwaway server/database (never a dev DB).
      expect(process.env.BUDGET_TEST_DB_ISOLATED).toBe('1');
      const name = `budgetnew_test_mig_${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;
      const maintenance = new pg.Client({ connectionString: databaseUrl(base, 'postgres') });
      await maintenance.connect();
      await maintenance.query(`create database ${name}`);
      const fresh = new pg.Pool({ connectionString: databaseUrl(base, name) });
      try {
        // 0010 is seed data for the seeded Casa budget and fails on an empty
        // database (the test preload runs it after db/seed); it has nothing to do
        // with 0109/0127, so it is pre-recorded here and every other file runs.
        await fresh.query('create table schema_migrations (filename text primary key, applied_at timestamptz not null default now())');
        await fresh.query("insert into schema_migrations (filename) values ('0010_ynab_parity_plan_data.sql')");
        await runMigrations(fresh);
        expect(await tableExists(fresh)).toBe(false);
        expect(await tracked(fresh)).toEqual(migrationFiles());

        await runMigrations(fresh);
        expect(await tableExists(fresh)).toBe(false);
        expect(await tracked(fresh)).toEqual(migrationFiles());
      } finally {
        await fresh.end();
        await maintenance.query(`drop database if exists ${name} with (force)`);
        await maintenance.end();
      }
    });

    it('a database at 0126 with the table present: 0127 drops it, and a rerun does not recreate it', async () => {
      await runMigrations();
      await pool.query(SQL_0109);
      await pool.query(
        "delete from schema_migrations where filename in ('0127_drop_ai_credentials.sql', '0128_suggestion_source_jev.sql')",
      );
      expect(await tableExists()).toBe(true);

      await runMigrations();
      expect(await tableExists()).toBe(false);
      expect(await tracked()).toEqual(migrationFiles());

      await runMigrations();
      expect(await tableExists()).toBe(false);
      expect(await tracked()).toEqual(migrationFiles());
    });

    it('fully tracked but the table came back (an older release re-ran its 0109): the next run drops it again', async () => {
      await runMigrations();
      await pool.query(SQL_0109);

      await runMigrations();
      expect(await tableExists()).toBe(false);
      expect(await tracked()).toEqual(migrationFiles());
    });

    it('adoption without tracking rows (dev-initdb.sh, schema restore) records everything and leaves no table', async () => {
      await runMigrations();
      await pool.query('delete from schema_migrations');
      await runMigrations();
      expect(await tableExists()).toBe(false);
      expect(await tracked()).toEqual(migrationFiles());

      // A restore of a pre-0127 dump: table present, no tracking rows.
      await pool.query(SQL_0109);
      await pool.query('delete from schema_migrations');
      await runMigrations();
      expect(await tableExists()).toBe(false);
      expect(await tracked()).toEqual(migrationFiles());
    });
  });

  it('0128 renames suggestion source ai to jev, leaves other sources, and is a no-op when re-run', async () => {
    const sql = readFileSync(join(MIGRATIONS_DIR, '0128_suggestion_source_jev.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      // Rows only, no parents: FK checks off for this rolled-back transaction.
      await client.query('set local session_replication_role = replica');
      const [budget, category] = [crypto.randomUUID(), crypto.randomUUID()];
      const [tAi, tRule] = [crypto.randomUUID(), crypto.randomUUID()];
      await client.query(
        `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source, provider, model)
         values ($1, $3, 1, $4, 0.9, 'ai', 'jev', 'typesafe/jev-1.13'), ($1, $3, 2, $4, 0.5, 'ai', 'jev', 'typesafe/jev-1.13'),
                ($2, $3, 1, $4, 1, 'payee_rule', null, null)`,
        [tAi, tRule, budget, category],
      );
      // Kept on for the update too: Postgres re-checks the FK of a row inserted
      // in the same transaction even when the key column is unchanged.

      const read = async () =>
        (await client.query<{ transaction_id: string; rank: number; source: string; provider: string | null; model: string | null }>(
          'select transaction_id, rank, source, provider, model from public.category_suggestions where budget_id = $1 order by transaction_id = $2 desc, rank',
          [budget, tAi],
        )).rows.map((r) => [r.transaction_id, r.rank, r.source, r.provider, r.model]);
      const expected = [
        [tAi, 1, 'jev', 'jev', 'typesafe/jev-1.13'],
        [tAi, 2, 'jev', 'jev', 'typesafe/jev-1.13'],
        [tRule, 1, 'payee_rule', null, null],
      ];

      await client.query(sql);
      expect(await read()).toEqual(expected);
      await client.query(sql);
      expect(await read()).toEqual(expected);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
  });

  it('concurrent runners both resolve and each migration is recorded once', async () => {
    await runMigrations();
    const full = await pool.query('select count(*)::int as n from schema_migrations');
    await pool.query('delete from schema_migrations');
    await Promise.all([runMigrations(), runMigrations()]);
    const after = await pool.query('select count(*)::int as n from schema_migrations');
    expect(after.rows[0].n).toBe(full.rows[0].n);
  });
});
