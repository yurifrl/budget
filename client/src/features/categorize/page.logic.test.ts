import { describe, expect, test } from 'bun:test';

import type { BundleRow, CategoryRow, GroupRow } from '@/budget/data/rows';

import {
  bundleToastLabel,
  categoryOptions,
  bundleChangedMessage,
  isBundleChanged,
  pageKey,
  rowsGoneFromQueue,
  skipFailureKind,
  rowSubject,
  thresholdFromX,
  thresholdLabel,
  thresholdPercent,
  thresholdReloading,
} from './page.logic';

const group = (over: Partial<GroupRow> = {}): GroupRow => ({
  id: 'g1',
  name: 'Everyday',
  sort_order: 0,
  is_credit_card_payments: false,
  hidden: false,
  internal: false,
  deleted: false,
  ...over,
});

const category = (over: Partial<CategoryRow> & { id: string; name: string }): CategoryRow => ({
  group_id: 'g1',
  sort_order: 0,
  note: null,
  hidden: false,
  internal: false,
  deleted: false,
  goal_type: null,
  goal_needs_whole_amount: null,
  goal_day: null,
  goal_cadence: null,
  goal_cadence_frequency: null,
  goal_creation_month: null,
  goal_target: null,
  goal_target_date: null,
  goal_snoozed_at: null,
  user_id: null,
  ...over,
});

const bundle = (id: string, name: string): BundleRow => ({ id, group_id: 'g1', name });

describe('threshold control', () => {
  test('percent rounds and clamps to 0..100', () => {
    expect(thresholdPercent(0.8)).toBe(80);
    expect(thresholdPercent(0.795)).toBe(80);
    expect(thresholdPercent(1.4)).toBe(100);
    expect(thresholdPercent(-1)).toBe(0);
  });

  test('a pointer position maps to a 0.01-step value', () => {
    expect(thresholdFromX(80, 100)).toBe(0.8);
    expect(thresholdFromX(0, 100)).toBe(0);
    expect(thresholdFromX(120, 100)).toBe(1);
    expect(thresholdFromX(10, 0)).toBe(0);
    expect(thresholdFromX(1, 3)).toBe(0.33);
  });

  test('the control label is the percent', () => {
    expect(thresholdLabel(0.8)).toBe('80%');
  });
});

describe('categoryOptions', () => {
  const groups = [
    group({ id: 'g1', name: 'Everyday' }),
    group({ id: 'cards', name: 'Credit Card Payments', is_credit_card_payments: true }),
    group({ id: 'hidden', name: 'Internal', internal: true }),
    group({ id: 'hiddenGroup', name: 'Hidden group', hidden: true }),
  ];
  const categories = [
    category({ id: 'c1', name: 'Restaurants' }),
    category({ id: 'c2', name: 'Groceries', bundle_id: 'b1' }),
    category({ id: 'c3', name: 'Hidden', hidden: true }),
    category({ id: 'c4', name: 'Deleted', deleted: true }),
    category({ id: 'c5', name: 'Internal', internal: true }),
    category({ id: 'c6', name: 'Card payment', group_id: 'cards' }),
    category({ id: 'c7', name: 'In internal group', group_id: 'hidden' }),
    category({ id: 'c8', name: 'In hidden group', group_id: 'hiddenGroup' }),
  ];

  test('keeps assignable categories and labels bundles', () => {
    const options = categoryOptions(categories, groups, [bundle('b1', 'Food')]);
    // c8 sits in a hidden group: the server refuses it, so the search never offers it.
    expect(options.map((o) => o.id)).toEqual(['c1', 'c2']);
    expect(options[1]).toEqual({ id: 'c2', label: 'Food › Groceries', sub: 'Everyday' });
  });
});

describe('accept helpers', () => {
  test('detects the bundle-changed 409 by its code', () => {
    expect(isBundleChanged({ status: 409, code: 'categorize_bundle_changed' })).toBe(true);
    expect(isBundleChanged({ status: 409, code: 'categorize_already_categorized' })).toBe(false);
    expect(isBundleChanged(null)).toBe(false);
    expect(isBundleChanged('categorize_bundle_changed')).toBe(false);
  });

  test('the row subject names the payee (or raw bank text) and the amount', () => {
    const money = (cents: number) => `${cents < 0 ? '–' : '+'} R$ ${Math.abs(cents) / 100}`;
    expect(rowSubject({ payee: 'Uber', raw_bank_description: 'UBER TRIP', amount: -18900 }, money)).toBe(
      'Uber · – R$ 18.9',
    );
    expect(rowSubject({ payee: null, raw_bank_description: 'PIX ENVIADO', amount: 120000 }, money)).toBe(
      'PIX ENVIADO · + R$ 120',
    );
    expect(rowSubject({ payee: '  ', raw_bank_description: null, amount: -100 }, money)).toBe(
      'Unnamed transaction · – R$ 0.1',
    );
  });

  test('the bundle toast names the payee, its count and the category', () => {
    expect(
      bundleToastLabel({
        payee: 'Uber',
        count: 9,
        suggestion: { category_id: 'c1', category_name: 'Transport', confidence: 0.93, reason: null, source: 'ai' },
      }),
    ).toBe('Uber · 9 transactions → Transport');
  });
});

describe('bundleChangedMessage', () => {
  test('names the old and the new count and says the list is updated', () => {
    expect(
      bundleChangedMessage({ status: 409, code: 'categorize_bundle_changed', params: { expected: 3, actual: 2 } }),
    ).toBe('That bundle changed from 3 to 2 transactions. The list is updated: check it and accept again.');
  });

  test('without counts it still says what happened', () => {
    expect(bundleChangedMessage({ status: 409, code: 'categorize_bundle_changed' })).toBe(
      'That bundle changed. The list is updated: check it and accept again.',
    );
  });
});

describe('thresholdReloading', () => {
  test('from the save until a newer queue read lands', () => {
    expect(thresholdReloading({ saving: true, stamp: null, fulfilledAt: 5, failed: false })).toBe(true);
    expect(thresholdReloading({ saving: false, stamp: 5, fulfilledAt: 5, failed: false })).toBe(true);
    expect(thresholdReloading({ saving: false, stamp: 5, fulfilledAt: 9, failed: false })).toBe(false);
  });

  test('a failed read does not leave the page locked; nothing pending is not reloading', () => {
    expect(thresholdReloading({ saving: false, stamp: 5, fulfilledAt: 5, failed: true })).toBe(false);
    expect(thresholdReloading({ saving: false, stamp: null, fulfilledAt: 5, failed: false })).toBe(false);
  });
});

describe('pageKey', () => {
  test('differs per budget, so a budget switch remounts the page', () => {
    expect(pageKey('b1')).not.toBe(pageKey('b2'));
    expect(pageKey('b1')).toBe(pageKey('b1'));
    expect(pageKey(null)).toBe('no-budget');
  });
});

describe('skipFailureKind', () => {
  test('a row that no longer needs a category is refused; anything else is retried', () => {
    expect(skipFailureKind({ status: 409, code: 'categorize_already_categorized' })).toBe('refused');
    expect(skipFailureKind({ status: 409, code: 'categorize_not_needing_category' })).toBe('refused');
    expect(skipFailureKind({ status: 500 })).toBe('retry');
    expect(skipFailureKind({ status: 400 })).toBe('rejected');
    expect(skipFailureKind({ status: 403 })).toBe('rejected');
    expect(skipFailureKind({ status: 404 })).toBe('rejected');
    expect(skipFailureKind({ status: 409, code: 'something_else' })).toBe('retry');
    expect(skipFailureKind({ status: 'FETCH_ERROR' })).toBe('retry');
    expect(skipFailureKind(null)).toBe('retry');
  });
});

describe('rowsGoneFromQueue', () => {
  const loaded = new Set(['a', 'b']);

  test('with the whole queue loaded, a missing row is gone', () => {
    expect(rowsGoneFromQueue(['a', 'x'], loaded, 2, 2)).toEqual(['x']);
  });

  test('with only a page of a longer queue loaded, nothing is known to be gone', () => {
    expect(rowsGoneFromQueue(['a', 'x'], loaded, 250, 200)).toEqual([]);
  });

  test('rows still listed stay', () => {
    expect(rowsGoneFromQueue(['a', 'b'], loaded, 2, 2)).toEqual([]);
  });
});
