import { describe, expect, test } from 'bun:test';

import { transactionsCreate, transactionsDelete, transactionsUpdate } from './transactions';

const budget_id = '11111111-1111-4111-8111-111111111111';
const account_id = '22222222-2222-4222-8222-222222222222';
const id = '33333333-3333-4333-8333-333333333333';
const deltas = [{ account_id, cleared_delta: 7, uncleared_delta: 0 }];
const txn = {
  account_id,
  date: '2025-04-02',
  payee: '',
  category_id: null,
  memo: '',
  outflow_cents: 100,
  inflow_cents: 0,
  cleared: 'uncleared',
  approved: true,
  flag: null,
  repeat: '',
};

// G13: clients can no longer supply balance deltas. The input objects are
// non-strict, so a stray `deltas` key is stripped from the parsed input.
describe('transactions contracts carry no client balance deltas', () => {
  test('create strips a supplied deltas key', () => {
    const parsed = transactionsCreate.input.parse({ budget_id, txn, deltas });
    expect(parsed).not.toHaveProperty('deltas');
  });

  test('update strips a supplied deltas key', () => {
    const parsed = transactionsUpdate.input.parse({ id, budget_id, patch: { memo: 'x' }, deltas });
    expect(parsed).not.toHaveProperty('deltas');
  });

  test('delete strips a supplied deltas key', () => {
    const parsed = transactionsDelete.input.parse({ id, budget_id, deltas });
    expect(parsed).not.toHaveProperty('deltas');
  });

  test('the input shapes do not declare deltas', () => {
    for (const c of [transactionsCreate, transactionsUpdate, transactionsDelete]) {
      expect(Object.keys(c.input.shape)).not.toContain('deltas');
    }
  });
});
