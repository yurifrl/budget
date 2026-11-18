import { describe, expect, it } from 'bun:test';

import { accountActivity, balanceReconcile, connectionActivitySeries, connectionSparkData } from './connectionSpark';
import type { AccountRow, TransactionRow } from '@/budget/data/rows';

/** One day ago, as the helpers' "today" anchor is the real clock. */
function daysAgo(n: number): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  const pad = (x: number) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function account(id: string, connectionId: string | null, clearedMilli = 1000): AccountRow {
  return {
    id,
    name: id,
    type: 'checking',
    account_group: 'CASH',
    on_budget: true,
    closed: false,
    note: null,
    cleared_balance: clearedMilli,
    uncleared_balance: 0,
    transfer_payee_id: null,
    direct_import_linked: false,
    direct_import_in_error: false,
    connection_id: connectionId,
    external_account_id: null,
    institution: null,
    user_id: null,
    last_reconciled_at: null,
    debt_interest_rates: null,
    debt_minimum_payments: null,
    debt_escrow_amounts: null,
    sort_order: 0,
    deleted: false,
  };
}

function txn(id: string, accountId: string, date: string, amount: number): TransactionRow {
  return {
    id,
    account_id: accountId,
    date,
    amount,
    payee_id: null,
    category_id: null,
    memo: null,
    cleared: 'cleared',
    approved: true,
    flag_color: null,
    flag_name: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: null,
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    repeat: '',
    repeat_rule_id: null,
    occurrence_date: null,
    upcoming: false,
    deleted: false,
  };
}

describe('connectionActivitySeries', () => {
  it('buckets amounts into daily slots ending today, oldest first', () => {
    const series = connectionActivitySeries([daysAgo(2), daysAgo(0), daysAgo(2)], [500, -200, 300], 5);
    expect(series).toEqual([0, 0, 800, 0, -200]);
  });

  it('ignores out-of-window and malformed dates', () => {
    const series = connectionActivitySeries([daysAgo(5), 'not-a-date'], [7, 99], 7);
    expect(series).toEqual([0, 7, 0, 0, 0, 0, 0]);
  });

  it('fills an all-zero window when no dates are given', () => {
    expect(connectionActivitySeries([], [], 3)).toEqual([0, 0, 0]);
  });
});

describe('connectionSparkData', () => {
  const connId = 'c1';
  const linkedA = account('a1', connId, 25000);
  const linkedB = account('a2', connId, 5000);
  const other = account('a3', 'c2', 99999);

  it('returns null for connections with no linked accounts', () => {
    expect(connectionSparkData('c9', [linkedA], [])).toBeNull();
  });

  it('combines linked-account balances (milliunits → cents) and filters txns to them', () => {
    const data = connectionSparkData(
      connId,
      [linkedA, linkedB, other],
      [txn('t1', 'a1', daysAgo(1), 120), txn('t2', 'a3', daysAgo(1), 500), txn('t3', 'a2', daysAgo(4), -30), txn('t4', 'a2', daysAgo(1), 10)],
    );
    expect(data).not.toBeNull();
    expect(data!.balanceCents).toBe(2500 + 500);
    expect(data!.series[28]).toBe(130); // t1 + t4, 1 day ago
    expect(data!.series[25]).toBe(-30); // t3, 4 days ago
  });

  it('skips deleted transactions', () => {
    const data = connectionSparkData(connId, [linkedA], [{ ...txn('t1', 'a1', daysAgo(0), 42), deleted: true }]);
    expect(data!.series.every((v) => v === 0)).toBe(true);
  });
});

describe('balanceReconcile', () => {
  it('matches when bank cents equal the cleared balance in cents', () => {
    expect(balanceReconcile(33162, account('a', 'c', 331_620))).toEqual({ matches: true, diffCents: 0 });
  });
  it('reports the absolute difference either way', () => {
    expect(balanceReconcile(33167, account('a', 'c', 331_620))).toEqual({ matches: false, diffCents: 5 });
    expect(balanceReconcile(33157, account('a', 'c', 331_620))).toEqual({ matches: false, diffCents: 5 });
  });
  it('is null when not linked', () => {
    expect(balanceReconcile(100, null)).toBeNull();
  });
});

describe('accountActivity', () => {
  it('sums inflow/outflow in cents for the one account, inside the window', () => {
    const rows = [
      txn('1', 'a', daysAgo(0), 100_000),
      txn('2', 'a', daysAgo(29), -25_000),
      txn('3', 'a', daysAgo(30), 999_000), // just outside
      txn('4', 'a', daysAgo(-1), 888_000), // future
      txn('5', 'b', daysAgo(1), 777_000), // other account
      { ...txn('6', 'a', daysAgo(2), 555_000), deleted: true },
    ];
    const r = accountActivity('a', rows, 30);
    expect(r.inCents).toBe(10_000);
    expect(r.outCents).toBe(2_500);
    expect(r.series).toHaveLength(30);
    expect(r.series[29]).toBe(100_000);
    expect(r.series[0]).toBe(-25_000);
  });
  it('is all zero with no transactions', () => {
    expect(accountActivity('a', [], 30)).toMatchObject({ inCents: 0, outCents: 0 });
  });
});

describe('timestamp dates', () => {
  it('accepts full ISO timestamps as returned by the API', () => {
    const r = accountActivity('a', [txn('1', 'a', `${daysAgo(1)}T03:00:00.000Z`, 50_000)], 30);
    expect(r.inCents).toBe(5_000);
    expect(r.series[28]).toBe(50_000);
  });
});
