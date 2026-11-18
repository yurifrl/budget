import { describe, expect, test } from 'bun:test';

import type { Transaction, TransactionSplit } from './types';
import { editDirty, newDraftDirty, type RowDraft } from './rowEdit';

const TODAY = '2026-10-04';

const baseDraft: RowDraft = {
  accountId: 'acc-1',
  date: TODAY,
  payee: '',
  categoryId: null,
  memo: '',
  outflowCents: 0,
  inflowCents: 0,
};

const txn: Transaction = {
  id: 't-1',
  accountId: 'acc-1',
  date: TODAY,
  payee: 'Mercado',
  categoryId: 'cat-1',
  memo: 'compras',
  outflow: 11500,
  inflow: 0,
  cleared: 'uncleared',
  approved: true,
  repeat: 'never',
  repeatRuleId: null,
  upcoming: false,
};

describe('newDraftDirty', () => {
  test('defaults (same account, today, empty everything) are clean', () => {
    expect(newDraftDirty(baseDraft, 'acc-1', TODAY)).toBe(false);
  });

  test.each([
    ['different account', { ...baseDraft, accountId: 'acc-2' }],
    ['different date', { ...baseDraft, date: '2026-10-05' }],
    ['payee typed', { ...baseDraft, payee: ' Nubank ' }],
    ['category picked', { ...baseDraft, categoryId: 'cat-1' }],
    ['memo typed', { ...baseDraft, memo: 'x' }],
    ['outflow amount', { ...baseDraft, outflowCents: 500 }],
    ['inflow amount', { ...baseDraft, inflowCents: 500 }],
  ])('%s is dirty', (_label, draft) => {
    expect(newDraftDirty(draft, 'acc-1', TODAY)).toBe(true);
  });

  test('whitespace-only payee/memo count as empty', () => {
    expect(newDraftDirty({ ...baseDraft, payee: '   ', memo: '  ' }, 'acc-1', TODAY)).toBe(false);
  });
});

describe('editDirty', () => {
  test('draft equal to stored transaction is clean', () => {
    const d: RowDraft = {
      accountId: txn.accountId,
      date: txn.date,
      payee: ' Mercado ',
      categoryId: txn.categoryId,
      memo: txn.memo,
      outflowCents: txn.outflow,
      inflowCents: txn.inflow,
    };
    expect(editDirty(txn, d)).toBe(false);
  });

  test.each([
    ['account', { accountId: 'acc-2' }],
    ['date', { date: '2026-10-05' }],
    ['payee', { payee: 'Other' }],
    ['category', { categoryId: null }],
    ['memo', { memo: 'edited' }],
    ['outflow', { outflowCents: 999 }],
    ['inflow', { inflowCents: 10 }],
  ])('changed %s is dirty', (_label, over) => {
    const d: RowDraft = {
      accountId: txn.accountId,
      date: txn.date,
      payee: txn.payee,
      categoryId: txn.categoryId,
      memo: txn.memo,
      outflowCents: txn.outflow,
      inflowCents: txn.inflow,
      ...over,
    };
    expect(editDirty(txn, d)).toBe(true);
  });

  test('amount reverted back to stored value is clean', () => {
    const d: RowDraft = {
      accountId: txn.accountId,
      date: txn.date,
      payee: txn.payee,
      categoryId: txn.categoryId,
      memo: txn.memo,
      outflowCents: 99000,
      inflowCents: 0,
    };
    expect(editDirty(txn, d)).toBe(true);
    expect(editDirty(txn, { ...d, outflowCents: txn.outflow, inflowCents: 0 })).toBe(false);
  });

  describe('splits', () => {
    const leg: TransactionSplit = {
      id: 's-1',
      categoryId: 'cat-1',
      memo: '',
      outflow: 5000,
      inflow: 0,
    };
    const splitTxn: Transaction = { ...txn, categoryId: null, outflow: 5000, splits: [leg] };

    test('same legs (order-insensitive ids aside) are clean', () => {
      const d: RowDraft = {
        accountId: txn.accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId: null,
        memo: txn.memo,
        outflowCents: 5000,
        inflowCents: 0,
      };
      expect(editDirty(splitTxn, d, [{ ...leg }])).toBe(false);
    });

    test('changed leg amount is dirty', () => {
      const d: RowDraft = {
        accountId: txn.accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId: null,
        memo: txn.memo,
        outflowCents: 5000,
        inflowCents: 0,
      };
      expect(editDirty(splitTxn, d, [{ ...leg, outflow: 6000 }])).toBe(true);
    });

    test('closed panel ignores split state entirely', () => {
      const d: RowDraft = {
        accountId: txn.accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId: null,
        memo: txn.memo,
        outflowCents: 5000,
        inflowCents: 0,
      };
      expect(editDirty(splitTxn, d)).toBe(false);
    });

    test('opening the panel on a non-split row (no legs yet) is clean — panel state alone is not a change', () => {
      const d: RowDraft = {
        accountId: txn.accountId,
        date: txn.date,
        payee: txn.payee,
        categoryId: txn.categoryId,
        memo: txn.memo,
        outflowCents: txn.outflow,
        inflowCents: txn.inflow,
      };
      expect(editDirty(txn, d, [])).toBe(false);
    });
  });
});
