import { describe, expect, test } from 'bun:test';

import type { CategorizeRunStatus } from '@/budget/data/api';
import type { BundleRow, CategoryRow, GroupRow } from '@/budget/data/rows';

import {
  aiReasonMessage,
  bundleToastLabel,
  categoryOptions,
  bundleChangedMessage,
  isBundleChanged,
  pageKey,
  rowsGoneFromQueue,
  skipFailureKind,
  rowSubject,
  runHeaderView,
  thresholdFromX,
  thresholdLabel,
  thresholdPercent,
  thresholdReloading,
} from './page.logic';

const format = { formatDate: (iso: string) => iso.split('-').reverse().join('/') };

const activeAi = { available: true, reason: null, provider: 'openrouter' as const, model: 'model/x', source: 'own' as const };

const finishedRun = {
  id: 'run-1',
  status: 'succeeded' as const,
  created_at: '2026-11-21T13:59:00Z',
  started_at: '2026-11-21T14:00:00Z',
  finished_at: '2026-11-21T14:02:00Z',
  total: 480,
  done: 480,
  suggested: 120,
  rule: 3,
  empty: 2,
  skipped: 0,
  failed: 1,
  remaining: 0,
  user_message: null,
};

const status = (over: Partial<CategorizeRunStatus> = {}): CategorizeRunStatus => ({
  active: null,
  last_finished: null,
  ai: activeAi,
  ...over,
});

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

describe('runHeaderView', () => {
  test('an active run shows live progress and its fraction', () => {
    const view = runHeaderView(
      status({
        active: {
          id: 'r1',
          status: 'running',
          created_at: '2026-11-21T14:00:00Z',
          started_at: '2026-11-21T14:00:01Z',
          requested_by: null,
          done: 120,
          total: 480,
        },
      }),
      { left_to_categorize: 480, not_classified: 300 },
      format,
    );
    expect(view).toEqual({
      kind: 'active',
      title: 'Classifying 120 of 480…',
      detail: 'Runs in the background. Suggestions appear here as they are ready; you can start accepting now.',
      fraction: 0.25,
    });
  });

  test('a queued run (no total yet) says it is starting', () => {
    const view = runHeaderView(
      status({
        active: {
          id: 'r1',
          status: 'queued',
          created_at: '2026-11-21T14:00:00Z',
          started_at: null,
          requested_by: null,
          done: 0,
          total: 0,
        },
      }),
      { left_to_categorize: 10, not_classified: 10 },
      format,
    );
    expect(view.title).toBe('Starting the classification…');
    expect(view.fraction).toBe(0);
  });

  test('AI unavailable explains the precise reason', () => {
    const view = runHeaderView(
      status({ ai: { available: false, reason: 'own_key_required', provider: null, model: null, source: null } }),
      { left_to_categorize: 480, not_classified: 480 },
      format,
    );
    expect(view).toEqual({
      kind: 'unavailable',
      title: 'Classification unavailable',
      detail: 'No AI key is set up for this budget.',
      fraction: 0,
    });
  });

  test('all rows classified shows the queue size and the last run', () => {
    const view = runHeaderView(
      status({ last_finished: finishedRun }),
      { left_to_categorize: 480, not_classified: 0 },
      format,
    );
    expect(view.kind).toBe('all_classified');
    expect(view.title).toBe('All 480 classified');
    expect(view.detail).toBe('Last run 21/11/2026 · 120 suggestions');
  });

  test('a partially classified queue shows the last run as the title', () => {
    const view = runHeaderView(
      status({ last_finished: finishedRun }),
      { left_to_categorize: 480, not_classified: 40 },
      format,
    );
    expect(view.kind).toBe('finished');
    expect(view.title).toBe('Last run 21/11/2026');
    expect(view.detail).toBe('120 suggestions. New imports are classified on the next run.');
  });

  test('an active run is not shown as healthy when AI is unavailable', () => {
    const view = runHeaderView(
      status({
        active: {
          id: 'r1',
          status: 'running',
          created_at: '2026-11-21T14:00:00Z',
          started_at: '2026-11-21T14:00:00Z',
          requested_by: null,
          done: 25,
          total: 57,
        },
        ai: { available: false, reason: 'shared_key_missing', provider: null, model: null, source: null },
      }),
      { left_to_categorize: 57, not_classified: 30 },
      format,
    );
    expect(view.kind).toBe('unavailable');
    expect(view.fraction).toBe(0);
    expect(view.detail).toContain('this server has none configured');
  });

  test('no run yet invites one; an empty queue says so', () => {
    expect(runHeaderView(status(), { left_to_categorize: 5, not_classified: 5 }, format).kind).toBe('never');
    expect(runHeaderView(status(), { left_to_categorize: 0, not_classified: 0 }, format).title).toBe(
      'Nothing left to categorize',
    );
  });
});

describe('aiReasonMessage', () => {
  test('one sentence per reason, with a fallback', () => {
    expect(aiReasonMessage('own_key_required')).toBe('No AI key is set up for this budget.');
    expect(aiReasonMessage('shared_model_missing')).toContain('no model chosen');
    expect(aiReasonMessage(null)).toBe('Category suggestions are unavailable right now.');
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

describe('last run date', () => {
  test('is the local calendar day of the instant, not the UTC day', () => {
    // 23:30 local on 24 Nov: in UTC this is the 25th in zones behind UTC, the 24th elsewhere.
    const lateEvening = new Date(2026, 10, 24, 23, 30).toISOString();
    const view = runHeaderView(
      status({ last_finished: { ...finishedRun, finished_at: lateEvening } }),
      { left_to_categorize: 0, not_classified: 0 },
      format,
    );
    expect(view.detail).toBe('Last run 24/11/2026 · 120 suggestions');
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
