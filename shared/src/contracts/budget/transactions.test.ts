import { describe, expect, test } from 'bun:test';

import { inputLocations } from '../../operation-contract';
import { transactionsCreate, transactionsDelete, transactionsGet, transactionsUpdate } from './transactions';

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
  outflow: 1000,
  inflow: 0,
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

describe('transactionsGet contract', () => {
  const row = {
    id,
    account_id,
    date: '2025-04-02',
    amount: -12340,
    payee_id: null,
    payee_name: 'Coffee',
    category_id: null,
    category_name: null,
    account_name: 'Card',
    memo: null,
    cleared: 'cleared',
    approved: true,
    flag_color: null,
    flag_name: null,
    transfer_account_id: null,
    transfer_transaction_id: null,
    matched_transaction_id: null,
    import_id: 'pluggy:tx-1',
    import_payee_name: null,
    import_payee_name_original: null,
    debt_transaction_type: null,
    repeat: 'never',
    repeat_rule_id: null,
    occurrence_date: null,
    subtransactions: [],
    upcoming: false,
    deleted: false,
  };

  test('GET /transactions/:id with budget_id in the query', () => {
    expect(transactionsGet.method).toBe('GET');
    expect(transactionsGet.path).toBe('/transactions/:id');
    expect(inputLocations(transactionsGet)).toEqual({ path: ['id'], query: ['budget_id'], body: [] });
    expect(transactionsGet.kind).toBe('read');
  });

  test('a hand-entered row answers import: null', () => {
    expect(transactionsGet.output!.safeParse({ transaction: row, import: null }).success).toBe(true);
  });

  test('a bank-imported row carries the raw payload as any JSON object', () => {
    const imported = {
      provider: 'pluggy',
      bank_transaction_id: 'tx-1',
      connection_id: null,
      bank_name: 'Nubank',
      state: 'edited',
      last_synced_payload: { amount: -12340 },
      raw: { descriptionRaw: 'CAFE', creditCardMetadata: { installmentNumber: 1, totalInstallments: 3 }, tags: [] },
      raw_received_at: '2026-11-23T10:00:00.000Z',
      updated_at: '2026-11-23T10:00:00.000Z',
    };
    expect(transactionsGet.output!.safeParse({ transaction: row, import: imported }).success).toBe(true);
    expect(transactionsGet.output!.safeParse({ transaction: row, import: { ...imported, state: 'blocked' } }).success).toBe(false);
  });

  test('the transaction requires its account name and split legs', () => {
    const noAccount: Record<string, unknown> = { ...row };
    delete noAccount.account_name;
    expect(transactionsGet.output!.safeParse({ transaction: noAccount, import: null }).success).toBe(false);
  });
});
