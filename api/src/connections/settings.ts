/**
 * App-level settings backed by the `app_settings` key/value table (0022).
 * One reader per setting, validated at the read site — unknown or malformed
 * values fall back to the documented default rather than failing requests.
 */

import { pool } from '../core/db';

/** 0 = All history: pulls have no lower bound (the provider default). */
export const ALL_HISTORY_DAYS = 0;
export const DEFAULT_SYNC_WINDOW_DAYS = ALL_HISTORY_DAYS;
import { MAX_SYNC_WINDOW_DAYS } from '@shared/contracts/connections/schemas';
export { MAX_SYNC_WINDOW_DAYS };

/** How far back pulls reach, in days — 0 means All history. */
export async function getSyncWindowDays(): Promise<number> {
  const row = await pool.query<{ value: unknown }>(
    `select value from public.app_settings where key = 'syncWindowDays'`,
  );
  const raw = row.rows[0]?.value;
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 0 && raw <= MAX_SYNC_WINDOW_DAYS
    ? raw
    : DEFAULT_SYNC_WINDOW_DAYS;
}

export async function setSyncWindowDays(days: number): Promise<number> {
  const updated = await pool.query<{ value: number }>(
    `insert into public.app_settings (key, value) values ('syncWindowDays', $1::jsonb)
     on conflict (key) do update set value = $1::jsonb, updated_at = now()
     returning (value)::int as value`,
    [JSON.stringify(days)],
  );
  return updated.rows[0]!.value;
}

/** A connection's own window wins; null inherits the app-wide default. */
export function effectiveSyncWindowDays(connectionDays: number | null, appDays: number): number {
  return connectionDays ?? appDays;
}
