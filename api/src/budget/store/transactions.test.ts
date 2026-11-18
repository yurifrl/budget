/**
 * updateTransactionSet renders exactly the statement the transactions route
 * used to build by hand (column order, placeholder numbering, literal
 * assignments, id last). No database: a recording Queryable.
 */
import { describe, expect, test } from 'bun:test';

import type { Queryable } from '../../core/db';
import { updateTransactionSet } from './transactions';

function recorder() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const db = {
    query: async (sql: string, values: unknown[]) => {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Queryable;
  return { db, calls };
}

describe('updateTransactionSet', () => {
  test('bound columns and literal assignments render in order, id is the last placeholder', async () => {
    const { db, calls } = recorder();
    await updateTransactionSet(db, 'txn-1', [
      { col: 'date', value: '2026-01-02' },
      { col: 'memo', value: null },
      { raw: 'repeat_rule_id = NULL' },
      { raw: 'occurrence_date = NULL' },
      { raw: 'upcoming = false' },
      { col: 'payee_id', value: 'p-1' },
      { col: 'category_id', value: null },
    ]);
    expect(calls).toEqual([
      {
        sql: 'UPDATE transactions SET date = $1, memo = $2, repeat_rule_id = NULL, occurrence_date = NULL, upcoming = false, payee_id = $3, category_id = $4 WHERE id = $5',
        values: ['2026-01-02', null, 'p-1', null, 'txn-1'],
      },
    ]);
  });

  test('an empty set issues no statement', async () => {
    const { db, calls } = recorder();
    await updateTransactionSet(db, 'txn-1', []);
    expect(calls).toEqual([]);
  });
});
