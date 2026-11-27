import { describe, expect, test } from 'bun:test';

import type { CategorizeTransferGroup } from '@/budget/data/api';

import {
  jevGroups,
  jevItems,
  matcherHeading,
  transferAcceptError,
  transferDecisions,
  transferHeading,
  transferPercent,
  transferSubject,
  visibleGroups,
} from './transfer.logic';

const row = (over: Partial<CategorizeTransferGroup['rows'][number]> = {}) => ({
  transaction_id: '11111111-1111-4111-8111-111111111111',
  date: '2026-11-20',
  amount: -4200,
  account_id: '22222222-2222-4222-8222-222222222222',
  account_name: 'Checking',
  payee_id: null,
  payee: 'Landlord',
  confidence: 0.91,
  ...over,
});

const group = (over: Partial<CategorizeTransferGroup> = {}): CategorizeTransferGroup => ({
  transfer_account_id: '33333333-3333-4333-8333-333333333333',
  transfer_account_name: 'Savings',
  direction: 'to',
  on_budget: true,
  total: -4200,
  rows: [row()],
  ...over,
});

/** The app's formatter takes CENTS; the wire money is integer milliunits. */
const money = (cents: number): string => `R$ ${(cents / 100).toFixed(2)}`;

describe('transferHeading', () => {
  test('names the account and the direction the money moved', () => {
    expect(transferHeading({ side: 'to', transferAccountName: 'Savings' })).toBe('Transfer to Savings');
    expect(transferHeading({ side: 'from', transferAccountName: 'Checking' })).toBe(
      'Transfer from Checking',
    );
  });
});

describe('transferPercent', () => {
  test('rounds to whole percent and stays inside the scale', () => {
    expect(transferPercent(0.91)).toBe(91);
    expect(transferPercent(0.905)).toBe(91);
    expect(transferPercent(-1)).toBe(0);
    expect(transferPercent(4)).toBe(100);
  });
});

describe('jevItems', () => {
  test('flattens the groups, carrying the account and the direction onto every row', () => {
    const items = jevItems([
      group(),
      group({
        transfer_account_id: '44444444-4444-4444-8444-444444444444',
        transfer_account_name: 'Card',
        direction: 'from',
        total: 900,
        rows: [row({ transaction_id: '55555555-5555-4555-8555-555555555555', amount: 900 })],
      }),
    ]);
    expect(items.map((item) => item.transaction_id)).toEqual([
      '11111111-1111-4111-8111-111111111111',
      '55555555-5555-4555-8555-555555555555',
    ]);
    expect(items.map((item) => item.transferAccountName)).toEqual(['Savings', 'Card']);
    expect(items.map((item) => item.side)).toEqual(['to', 'from']);
    expect(items.every((item) => item.onBudget)).toBe(true);
  });
});

describe('jevGroups', () => {
  test('reads the pair outflow first, whichever side was asked about', () => {
    const [to] = jevGroups([group()]);
    expect(to!.pair).toBe('Checking → Savings');
    expect(to!.heading).toBe('Transfer to Savings');

    const [from] = jevGroups([
      group({ direction: 'from', total: 4200, rows: [row({ amount: 4200 })] }),
    ]);
    // An inflow in Checking answers "Transfer / Savings": the money left Savings.
    expect(from!.pair).toBe('Savings → Checking');
    expect(from!.heading).toBe('Transfer from Savings');
  });

  test('one entry per account and direction, with the sum it was sent', () => {
    const views = jevGroups([group({ total: -8400, rows: [row(), row()] })]);
    expect(views).toHaveLength(1);
    expect(views[0]!.key).toBe(
      '22222222-2222-4222-8222-222222222222:33333333-3333-4333-8333-333333333333:to',
    );
    expect(views[0]!.total).toBe(-8400);
    expect(views[0]!.items).toHaveLength(2);
  });

  test('a server group holding two own accounts splits into one group per real pair', () => {
    // Probe: the server groups by (named account, direction), so rows from
    // Checking and Card arrived under one heading that named Checking.
    const card = row({
      transaction_id: '44444444-4444-4444-8444-444444444444',
      account_id: '55555555-5555-4555-8555-555555555555',
      account_name: 'Card',
      payee: 'Groceries',
      amount: -8400,
    });
    const views = jevGroups([group({ total: -12600, rows: [row(), card] })]);

    expect(views).toHaveLength(2);
    expect(views.map((view) => view.heading)).toEqual([
      'Transfer to Savings',
      'Transfer to Savings',
    ]);
    expect(views.map((view) => view.pair)).toEqual(['Checking → Savings', 'Card → Savings']);
    expect(views.map((view) => view.total)).toEqual([-4200, -8400]);
  });
});

describe('transferDecisions', () => {
  test('each item names the row and the account, never a category', () => {
    const [item] = jevItems([group()]);
    expect(transferDecisions([item!])).toEqual([
      { transaction_id: '11111111-1111-4111-8111-111111111111', transfer_account_id: '33333333-3333-4333-8333-333333333333' },
    ]);
  });
});

describe('transferSubject', () => {
  test('payee and amount, with the wire milliunits converted to cents once', () => {
    // -300000 milliunits is -300.00: passing it through as cents would say -3000.00.
    expect(transferSubject({ payee: 'Landlord', amount: -300000 }, money)).toBe(
      'Landlord · R$ -300.00',
    );
    expect(transferSubject({ payee: '   ', amount: 900 }, money)).toBe('Unnamed transaction · R$ 0.90');
  });
});

describe('visibleGroups', () => {
  test('answered rows leave the section and an empty pair leaves with them', () => {
    const answered = row({ transaction_id: '66666666-6666-4666-8666-666666666666' });
    const views = visibleGroups(jevGroups([group({ rows: [row(), answered] })]), new Set([answered.transaction_id]));
    expect(views).toHaveLength(1);
    expect(views[0]!.items).toHaveLength(1);
    expect(views[0]!.total).toBe(-4200);
    expect(visibleGroups(views, new Set([row().transaction_id]))).toEqual([]);
  });
});

describe('transferAcceptError', () => {
  test('a transfer row the server turned down gets its own sentence', () => {
    expect(transferAcceptError({ status: 409, code: 'categorize_already_categorized' })).toBe(
      'This row is already categorized, so it is not a transfer any more.',
    );
    expect(transferAcceptError({ data: { code: 'categorize_not_needing_category' } })).toBe(
      'This row no longer needs a category: it is a transfer already.',
    );
    expect(transferAcceptError({ code: 'categorize_transfer_refused' })).toContain('not a transfer');
  });

  test('anything else falls back to the generic accept sentence', () => {
    expect(transferAcceptError({ status: 500 })).toBeUndefined();
    expect(transferAcceptError(new Error('offline'))).toBeUndefined();
  });
});

describe('matcherHeading', () => {
  test('names both accounts when both sides are known, else the one that is', () => {
    expect(matcherHeading({ fromAccount: 'Itaú', toAccount: 'Nubank' })).toBe('Itaú → Nubank');
    expect(matcherHeading({ fromAccount: 'Itaú', toAccount: null })).toBe('Transfer from Itaú');
    expect(matcherHeading({ fromAccount: null, toAccount: 'Nubank' })).toBe('Transfer to Nubank');
    expect(matcherHeading({ fromAccount: null, toAccount: null })).toBe('');
  });
});
