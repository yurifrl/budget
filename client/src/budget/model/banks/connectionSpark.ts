/**
 * Connection sparkline data — pure helpers that turn the linked budget
 * accounts' transaction rows into the inputs of the connections list's
 * `Sparkline` and balance column. Kept free of UI so the same series can feed
 * any surface (rows, detail pages, widgets).
 */

import type { AccountRow, TransactionRow } from '../../data/rows';

/**
 * Bucket signed transaction amounts into `days` daily slots ending today —
 * the input for the connections list's activity sparkline. Dates are ISO
 * `YYYY-MM-DD` (the storage boundary); amounts are raw signed numbers, unit
 * declared by the caller. Oldest slot first; out-of-window rows are ignored.
 */
export function connectionActivitySeries(dates: string[], amounts: number[], days: number): number[] {
  const buckets = new Array<number>(days).fill(0);
  for (let i = 0; i < dates.length; i++) {
    const age = dayAge(dates[i]);
    if (age == null) continue;
    const slot = days - 1 - age;
    if (slot >= 0 && slot < days) buckets[slot] += amounts[i] ?? 0;
  }
  return buckets;
}

/** Whole days between an ISO date and today (0 = today); NaN-safe (null). */
function dayAge(date: string): number | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const day = new Date(`${date.slice(0, 10)}T00:00:00`); // API rows may carry a full timestamp
  if (Number.isNaN(day.getTime())) return null;
  day.setHours(0, 0, 0, 0);
  return Math.round((today.getTime() - day.getTime()) / 86_400_000);
}

/** Dates + amounts of the non-deleted transactions of the given accounts. */
function liveActivity(accountIds: Set<string>, transactions: TransactionRow[]): { dates: string[]; amounts: number[] } {
  const dates: string[] = [];
  const amounts: number[] = [];
  for (const t of transactions) {
    if (t.deleted || !accountIds.has(t.account_id)) continue;
    dates.push(t.date);
    amounts.push(t.amount);
  }
  return { dates, amounts };
}

/**
 * One budget account's last-`days` activity: the daily net series for the
 * sparkline plus inflow/outflow sums in cents (transaction amounts are
 * milliunits, ÷10 → cents). Deleted rows are excluded; the window is the
 * `days` calendar days ending today (inclusive), matching the series.
 */
export function accountActivity(
  accountId: string,
  transactions: TransactionRow[],
  days = 30,
): { series: number[]; inCents: number; outCents: number } {
  const { dates, amounts } = liveActivity(new Set([accountId]), transactions);
  let inMilli = 0;
  let outMilli = 0;
  for (let i = 0; i < dates.length; i++) {
    const age = dayAge(dates[i]);
    if (age == null || age < 0 || age >= days) continue;
    if (amounts[i] > 0) inMilli += amounts[i];
    else outMilli += -amounts[i];
  }
  return {
    series: connectionActivitySeries(dates, amounts, days),
    inCents: Math.round(inMilli / 10),
    outCents: Math.round(outMilli / 10),
  };
}

/**
 * Bank balance vs the linked budget account. Compares against the CLEARED
 * balance (milliunits → cents): imported bank rows are cleared, and the bank
 * reports its settled balance, so uncleared (manually entered, not yet at the
 * bank) amounts must not count as a difference. Null when not linked.
 */
export function balanceReconcile(
  bankCents: number,
  account: Pick<AccountRow, 'cleared_balance'> | null | undefined,
): { matches: boolean; diffCents: number } | null {
  if (!account) return null;
  const diffCents = Math.abs(bankCents - Math.round(account.cleared_balance / 10));
  return { matches: diffCents === 0, diffCents };
}

/**
 * A connection's linked budget accounts plus the 30-day daily-activity
 * series and combined cleared balance (cents) that feed its row. Returns
 * null for connections with no linked accounts — the row renders without a
 * sparkline or balance.
 */
export function connectionSparkData(
  connectionId: string,
  accounts: AccountRow[],
  transactions: TransactionRow[],
  days = 30,
): { series: number[]; balanceCents: number } | null {
  const linked = accounts.filter((a) => a.connection_id === connectionId);
  if (linked.length === 0) return null;
  const ids = new Set(linked.map((a) => a.id));
  const { dates, amounts } = liveActivity(ids, transactions);
  return {
    series: connectionActivitySeries(dates, amounts, days),
    balanceCents: linked.reduce((sum, a) => sum + Math.round(a.cleared_balance / 10), 0),
  };
}
