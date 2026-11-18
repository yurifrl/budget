/**
 * withTransaction: commit on success, rollback + rethrow on failure, client
 * always released (pool counts return to idle), explicit ROLLBACK inside fn
 * tolerated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { pool, withTransaction } from './db';
import { dbReady } from './test-gate';

const table = `wtx_probe_${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`;

describe.skipIf(!dbReady)('withTransaction', () => {
  beforeAll(async () => {
    await pool.query(`create table ${table} (v int not null)`);
  });
  afterAll(async () => {
    await pool.query(`drop table if exists ${table}`);
  });

  const count = async () => (await pool.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

  test('commits and returns the callback value', async () => {
    const before = await count();
    const out = await withTransaction(pool, async (client) => {
      await client.query(`insert into ${table} (v) values (1)`);
      return 'ok';
    });
    expect(out).toBe('ok');
    expect(await count()).toBe(before + 1);
  });

  test('rolls back and rethrows the same error', async () => {
    const before = await count();
    const boom = new Error('boom');
    let caught: unknown;
    try {
      await withTransaction(pool, async (client) => {
        await client.query(`insert into ${table} (v) values (2)`);
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(await count()).toBe(before);
  });

  test('an explicit ROLLBACK inside fn before throwing is tolerated', async () => {
    const before = await count();
    const boom = new Error('missing row');
    let caught: unknown;
    try {
      await withTransaction(pool, async (client) => {
        await client.query(`insert into ${table} (v) values (3)`);
        await client.query('ROLLBACK');
        throw boom;
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(boom);
    expect(await count()).toBe(before);
  });

  test('a SQL error rolls back earlier statements and releases the client', async () => {
    const before = await count();
    const checkedOut = pool.totalCount - pool.idleCount;
    await expect(
      withTransaction(pool, async (client) => {
        await client.query(`insert into ${table} (v) values (4)`);
        await client.query(`insert into ${table} (v) values (null)`);
      }),
    ).rejects.toThrow();
    expect(await count()).toBe(before);
    // The client went back to the pool: no more checked out than before.
    expect(pool.totalCount - pool.idleCount).toBeLessThanOrEqual(checkedOut);
  });
});
