import { describe, expect, test } from 'bun:test';

import { moneyFormat } from '@/domain/format';
import type { TransactionDetails } from '@/budget/data/api';

import { containerSummary, detailFields, formatMilli, formatTimestamp, rawJson, rawLines } from './transactionDetail.logic';

const fmt = moneyFormat();

const txn = (over: Partial<TransactionDetails['transaction']> = {}): TransactionDetails['transaction'] => ({
  id: 'txn-1',
  account_id: 'acc-1',
  date: '2026-11-20',
  amount: -12340,
  payee_id: 'p-1',
  payee_name: 'Padaria',
  category_id: 'c-1',
  category_name: 'Groceries',
  account_name: 'Card',
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
  repeat: 'never',
  repeat_rule_id: null,
  occurrence_date: null,
  subtransactions: [],
  upcoming: false,
  deleted: false,
  ...over,
});
const names = { payee: 'Padaria', flag: null };

describe('detailFields', () => {
  test('a plain hand-entered row: the always-shown fields, formatted', () => {
    const rows = detailFields(txn(), fmt, names);
    expect(rows.map((r) => [r.key, r.value])).toEqual([
      ['date', fmt.formatDate('2026-11-20')],
      ['payee', 'Padaria'],
      ['category', 'Groceries'],
      ['account', 'Card'],
      ['amount', fmt.formatMoney(-1234)],
      ['cleared', 'Cleared'],
      ['approved', 'Yes'],
      ['id', 'txn-1'],
    ]);
    expect(rows.find((r) => r.key === 'id')?.mono).toBe(true);
  });

  test('optional fields appear only when set; a split shows Split', () => {
    const rows = detailFields(
      txn({
        memo: 'note',
        approved: false,
        cleared: 'uncleared',
        import_id: 'pluggy:tx-1',
        import_payee_name_original: 'PADARIA DO ZE',
        category_name: null,
        matched_transaction_id: 'txn-2',
        subtransactions: [
          {
            id: 's1', transaction_id: 'txn-1', amount: -1000, memo: null, payee_id: null, category_id: null,
            transfer_account_id: null, transfer_transaction_id: null, deleted: false, category_name: null,
          },
        ],
      }),
      fmt,
      { payee: 'Padaria', flag: 'Red' },
    );
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey).toMatchObject({
      category: 'Split',
      memo: 'note',
      cleared: 'Uncleared',
      approved: 'No',
      flag: 'Red',
      matched: 'txn-2',
      importPayee: 'PADARIA DO ZE',
      importId: 'pluggy:tx-1',
    });
  });

  test('uncategorized and reconciled labels', () => {
    const byKey = Object.fromEntries(
      detailFields(txn({ category_name: null, category_id: null, cleared: 'reconciled' }), fmt, names).map((r) => [r.key, r.value]),
    );
    expect(byKey.category).toBe('Uncategorized');
    expect(byKey.cleared).toBe('Reconciled');
  });
});

describe('formatters', () => {
  test('milliunits go through the cents formatter', () => {
    expect(formatMilli(fmt, -12340)).toBe(fmt.formatMoney(-1234));
  });
  test('timestamps: budget date format plus local HH:MM; junk passes through', () => {
    const at = new Date(2026, 10, 21, 9, 5);
    expect(formatTimestamp(fmt, at.toISOString())).toBe(`${fmt.formatDate('2026-11-21')} 09:05`);
    expect(formatTimestamp(fmt, 'not a date')).toBe('not a date');
  });
});

describe('rawLines', () => {
  test('every field, nested objects and arrays expanded, in key order', () => {
    const lines = rawLines({
      id: 'tx-1',
      amount: -12.34,
      descriptionRaw: '',
      paymentData: null,
      merchant: { name: 'Padaria', address: {} },
      tags: [],
      creditCardMetadata: { installments: [{ n: 1 }, true] },
      pending: false,
    });
    expect(lines.map((l) => [l.path, l.depth, l.key, l.kind, l.value ?? l.count])).toEqual([
      ['id', 0, 'id', 'string', 'tx-1'],
      ['amount', 0, 'amount', 'number', '-12.34'],
      ['descriptionRaw', 0, 'descriptionRaw', 'string', '""'],
      ['paymentData', 0, 'paymentData', 'null', 'null'],
      ['merchant', 0, 'merchant', 'object', 2],
      ['merchant.name', 1, 'name', 'string', 'Padaria'],
      ['merchant.address', 1, 'address', 'object', 0],
      ['tags', 0, 'tags', 'array', 0],
      ['creditCardMetadata', 0, 'creditCardMetadata', 'object', 1],
      ['creditCardMetadata.installments', 1, 'installments', 'array', 2],
      ['creditCardMetadata.installments[0]', 2, '[0]', 'object', 1],
      ['creditCardMetadata.installments[0].n', 3, 'n', 'number', '1'],
      ['creditCardMetadata.installments[1]', 2, '[1]', 'boolean', 'true'],
      ['pending', 0, 'pending', 'boolean', 'false'],
    ]);
  });

  test('a key containing a dot stays its own field', () => {
    const lines = rawLines({ a: { b: [1, 2] }, 'a.b': 3 });
    expect(lines.map((l) => [l.key, l.depth])).toEqual([['a', 0], ['b', 1], ['[0]', 2], ['[1]', 2], ['a.b', 0]]);
  });

  test('an empty payload has no lines; a root array lists its items at depth 0', () => {
    expect(rawLines({})).toEqual([]);
    expect(rawLines(['x']).map((l) => [l.path, l.depth, l.key])).toEqual([['[0]', 0, '[0]']]);
  });
});

describe('containerSummary / rawJson', () => {
  test('empty containers read {} / []; others count fields or items', () => {
    expect(containerSummary({ kind: 'object', count: 0 })).toBe('{}');
    expect(containerSummary({ kind: 'array', count: 0 })).toBe('[]');
    expect(containerSummary({ kind: 'object', count: 1 })).toBe('1 field');
    expect(containerSummary({ kind: 'array', count: 3 })).toBe('3 items');
  });
  test('pretty JSON, every field kept', () => {
    expect(rawJson({ a: null, b: [1] })).toBe('{\n  "a": null,\n  "b": [\n    1\n  ]\n}');
  });
});
