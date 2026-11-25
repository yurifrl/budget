import { describe, expect, test } from 'bun:test';

import type {
  CategorizeBundle,
  CategorizeMerchantPanel,
  CategorizeQueue,
  CategorizeQueueRow,
  CategorizeSuggestion,
} from '@/budget/data/api';

import {
  bundleAcceptInput,
  bundlesWithoutLeaving,
  countsWithoutLeaving,
  bundleDateRange,
  bundleView,
  BUNDLE_CARD_LIMIT,
  confidenceBand,
  manualStateLabel,
  merchantFacts,
  queueSubtitle,
  topSuggestions,
} from './queue.logic';

const suggestion = (name: string, confidence = 0.95): CategorizeSuggestion => ({
  category_id: `cat-${name}`,
  category_name: name,
  confidence,
  reason: null,
  source: 'ai',
});

const row = (over: Partial<CategorizeQueueRow> = {}): CategorizeQueueRow => ({
  transaction_id: 'txn-1',
  date: '2026-11-21',
  amount: -1890,
  account_id: 'acct-1',
  account_name: 'Nubank',
  payee_id: 'payee-1',
  payee: 'Uber',
  memo: null,
  raw_bank_description: 'UBER *TRIP HELP.UBER.COM',
  merchant: null,
  state: 'has_suggestions',
  suggestions: [suggestion('Transport', 0.93)],
  ...over,
});

const bundle = (key: string, payee: string, count: number, over: Partial<CategorizeBundle> = {}): CategorizeBundle => ({
  bundle_key: key,
  payee_id: `payee-${key}`,
  payee,
  count,
  total: -count * 1000,
  first_date: '2026-10-02',
  last_date: '2026-11-21',
  suggestion: suggestion('Transport', 0.93),
  ...over,
});

const queue = (rows: CategorizeQueueRow[], bundles: CategorizeBundle[], over: Partial<CategorizeQueue['counts']> = {}): CategorizeQueue => ({
  rows,
  bundles,
  counts: {
    left_to_categorize: 480,
    above_threshold: 456,
    has_suggestions: 456,
    below_threshold: 10,
    no_suggestion: 8,
    failed: 4,
    not_classified: 2,
    ...over,
  },
});

describe('confidenceBand', () => {
  test('green from 90%, yellow from 70%, grey below', () => {
    expect(confidenceBand(1)).toBe('high');
    expect(confidenceBand(0.9)).toBe('high');
    expect(confidenceBand(0.899)).toBe('mid');
    expect(confidenceBand(0.7)).toBe('mid');
    expect(confidenceBand(0.699)).toBe('low');
    expect(confidenceBand(0)).toBe('low');
  });
});

describe('topSuggestions', () => {
  test('keeps at most three chips, best first', () => {
    const chips = [suggestion('A', 0.9), suggestion('B', 0.5), suggestion('C', 0.3), suggestion('D', 0.1)];
    expect(topSuggestions(chips).map((c) => c.category_name)).toEqual(['A', 'B', 'C']);
    expect(topSuggestions([])).toEqual([]);
  });
});

describe('bundleView', () => {
  test('sorts bundles by count, shows the first BUNDLE_CARD_LIMIT and sums the rest', () => {
    const bundles = [
      bundle('b1', 'Alpha', 3),
      bundle('b2', 'Bravo', 14),
      bundle('b3', 'Charlie', 9),
      ...Array.from({ length: 7 }, (_, i) => bundle(`x${i}`, `Extra ${i}`, 2)),
    ];
    const view = bundleView(queue([row()], bundles));
    expect(view.all.map((b) => b.count)).toEqual([14, 9, 3, 2, 2, 2, 2, 2, 2, 2]);
    expect(view.shown).toHaveLength(BUNDLE_CARD_LIMIT);
    expect(view.hidden).toHaveLength(2);
    expect(view.hiddenTransactionCount).toBe(4);
    expect(view.acceptAllCount).toBe(3 + 14 + 9 + 7 * 2);
  });

  test('breaks count ties by payee', () => {
    const view = bundleView(queue([], [bundle('b1', 'Zeta', 2), bundle('b2', 'Alpha', 2)]));
    expect(view.all.map((b) => b.payee)).toEqual(['Alpha', 'Zeta']);
  });

  test('manual group holds rows without a visible suggestion, counted from the whole queue', () => {
    const rows = [
      row({ transaction_id: 'has', state: 'has_suggestions' }),
      row({ transaction_id: 'below', state: 'below_threshold', suggestions: [] }),
      row({ transaction_id: 'none', state: 'no_suggestion', suggestions: [] }),
    ];
    const view = bundleView(queue(rows, [bundle('b1', 'Uber', 1)], { left_to_categorize: 24, above_threshold: 0 }));
    expect(view.manualRows.map((r) => r.transaction_id)).toEqual(['below', 'none']);
    expect(view.manualCount).toBe(24);
  });

  test('never reports a negative manual count on inconsistent input', () => {
    const view = bundleView(queue([], [], { left_to_categorize: 5, above_threshold: 9 }));
    expect(view.manualCount).toBe(0);
  });
});

describe('queueSubtitle', () => {
  test('names the queue size and the ready suggestions in English', () => {
    expect(queueSubtitle({ left_to_categorize: 480, above_threshold: 120 })).toBe(
      '480 uncategorized transactions · suggestions ready for 120',
    );
    expect(queueSubtitle({ left_to_categorize: 1, above_threshold: 0 })).toBe(
      '1 uncategorized transaction · suggestions ready for 0',
    );
  });
});

describe('bundle date range and accept input', () => {
  const format = {
    formatDate: (iso: string) => iso.split('-').reverse().join('/'),
    formatDateShort: (iso: string) => iso.split('-').reverse().slice(0, 2).join('/'),
  };

  test('same-year span shows day and month only', () => {
    expect(bundleDateRange({ first_date: '2026-10-02', last_date: '2026-11-21' }, format)).toBe('02/10 – 21/11');
  });

  test('a span across years keeps the full dates', () => {
    expect(bundleDateRange({ first_date: '2025-12-28', last_date: '2026-01-03' }, format)).toBe('28/12/2025 – 03/01/2026');
  });

  test('accept sends the bundle key with the count the card shows', () => {
    expect(bundleAcceptInput({ bundle_key: 'b-key', count: 9 })).toEqual({ bundleKey: 'b-key', expectedCount: 9 });
  });
});

describe('manualStateLabel', () => {
  test('explains every manual state and yields nothing for a suggestion row', () => {
    expect(manualStateLabel('below_threshold')).toBe('below the threshold');
    expect(manualStateLabel('no_suggestion')).toBe('no suggestion');
    expect(manualStateLabel('failed')).toBe('classification failed');
    expect(manualStateLabel('not_classified')).toBe('not classified');
    expect(manualStateLabel('has_suggestions')).toBe('');
  });
});

describe('merchantFacts', () => {
  test('keeps only the facts the bank sent, in fixed order', () => {
    const merchant: CategorizeMerchantPanel = {
      name: 'Posto Ipiranga',
      legal_name: 'Posto Ipiranga Ltda',
      cnpj: null,
      business_category: 'Gas stations',
      operation_type: null,
      counterparty_name: null,
    };
    expect(merchantFacts(merchant)).toEqual([
      { key: 'name', label: 'Merchant', value: 'Posto Ipiranga' },
      { key: 'legal_name', label: 'Legal name', value: 'Posto Ipiranga Ltda' },
      { key: 'business_category', label: "Bank's category", value: 'Gas stations' },
    ]);
  });

  test('a PIX row shows its counterparty', () => {
    const merchant: CategorizeMerchantPanel = {
      name: null,
      legal_name: null,
      cnpj: null,
      business_category: null,
      operation_type: 'PIX',
      counterparty_name: 'Mariana Souza',
    };
    expect(merchantFacts(merchant).map((f) => f.key)).toEqual(['operation_type', 'counterparty_name']);
  });

  test('the trade name is dropped when it is the payee already shown', () => {
    const merchant: CategorizeMerchantPanel = {
      name: 'Posto Ipiranga',
      legal_name: 'Posto Ipiranga Ltda',
      cnpj: '12.345.678/0001-90',
      business_category: null,
      operation_type: null,
      counterparty_name: null,
    };
    expect(merchantFacts(merchant, ' posto ipiranga ').map((f) => f.key)).toEqual(['legal_name', 'cnpj']);
    expect(merchantFacts(merchant, 'Ipiranga').map((f) => f.key)).toEqual(['name', 'legal_name', 'cnpj']);
  });

  test('no merchant block means no panel', () => {
    expect(merchantFacts(null)).toEqual([]);
  });
});

describe('counts without the rows in the strip', () => {
  const leaving = (payeeId: string | null, topCategoryId: string | null, amount = -1000) => ({ payeeId, topCategoryId, amount });

  test('a bundle loses the leaving rows of its payee and top suggestion, count and total', () => {
    const bundles = [bundle('b1', 'Uber', 3), bundle('b2', 'Netflix', 2)];
    const shown = bundlesWithoutLeaving(bundles, [leaving('payee-b1', 'cat-Transport', -2000)]);
    expect(shown.map((b) => [b.payee, b.count, b.total, b.serverCount])).toEqual([
      ['Uber', 2, -3000 + 2000, 3],
      ['Netflix', 2, -2000, 2],
    ]);
  });

  test('a row with another suggestion or payee does not touch the bundle', () => {
    const shown = bundlesWithoutLeaving([bundle('b1', 'Uber', 3)], [leaving('payee-b1', 'cat-Other'), leaving('other', 'cat-Transport')]);
    expect(shown[0]!.count).toBe(3);
  });

  test('a bundle with nothing left is dropped', () => {
    const shown = bundlesWithoutLeaving([bundle('b1', 'Uber', 2)], [leaving('payee-b1', 'cat-Transport'), leaving('payee-b1', 'cat-Transport')]);
    expect(shown).toEqual([]);
  });

  test('header counts drop leaving rows, and those with a suggestion drop "ready" too', () => {
    const counts = { left_to_categorize: 57, above_threshold: 52 };
    expect(countsWithoutLeaving(counts, [leaving('p', 'c'), leaving('p', null)])).toEqual({
      left_to_categorize: 55,
      above_threshold: 51,
    });
    expect(countsWithoutLeaving(counts, [])).toEqual(counts);
  });

  test('the view counts what Accept all would file, and the manual group', () => {
    const q = queue([], [bundle('b1', 'Uber', 3)], { left_to_categorize: 10, above_threshold: 3 });
    const view = bundleView(q, [leaving('payee-b1', 'cat-Transport'), leaving(null, null)]);
    expect(view.acceptAllCount).toBe(2);
    expect(view.manualCount).toBe(8 - 2);
  });
});
