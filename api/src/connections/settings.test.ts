/**
 * Tests for server/connections/settings.ts — the app_settings-backed sync
 * window: default All history (0), round-trip persistence, and the documented
 * fallback for malformed stored values.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { pool } from '../core/db';

import { getSyncWindowDays, setSyncWindowDays } from './settings';

const dbReady = await pool
  .query("select to_regclass('public.app_settings')::text is not null as t")
  .then((r) => r.rows[0]!.t)
  .catch(() => false);

describe.skipIf(!dbReady)('connections settings (sync window)', () => {
  beforeEach(async () => {
    await pool.query(`delete from public.app_settings where key = 'syncWindowDays'`);
  });

  afterEach(async () => {
    await pool.query(`delete from public.app_settings where key = 'syncWindowDays'`);
  });

  it('defaults to All history (0) when unset', async () => {
    expect(await getSyncWindowDays()).toBe(0);
  });

  it('round-trips a capped lookback', async () => {
    expect(await setSyncWindowDays(90)).toBe(90);
    expect(await getSyncWindowDays()).toBe(90);
    expect(await setSyncWindowDays(0)).toBe(0);
    expect(await getSyncWindowDays()).toBe(0);
  });

  it('falls back to the default on a malformed stored value', async () => {
    await pool.query(
      `insert into public.app_settings (key, value) values ('syncWindowDays', '"ninety"')`,
    );
    expect(await getSyncWindowDays()).toBe(0);
  });
});
