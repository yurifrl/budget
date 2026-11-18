import { readdirSync } from 'fs';
import { join } from 'path';

import { describe, it, expect } from 'bun:test';

import { pool } from './db';
import { MIGRATION_EXEMPT, MIGRATION_SIGNATURES, runMigrations } from './migrate';

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

  it('concurrent runners both resolve and each migration is recorded once', async () => {
    await runMigrations();
    const full = await pool.query('select count(*)::int as n from schema_migrations');
    await pool.query('delete from schema_migrations');
    await Promise.all([runMigrations(), runMigrations()]);
    const after = await pool.query('select count(*)::int as n from schema_migrations');
    expect(after.rows[0].n).toBe(full.rows[0].n);
  });
});
