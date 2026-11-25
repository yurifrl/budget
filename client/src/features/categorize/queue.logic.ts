/**
 * Pure view-model of the Categorize queue: bundle cards, the manual-pick
 * group, suggestion limits/confidence bands, the merchant-panel facts and the
 * accept payloads. Wire-typed (feature-local): the server already applied the
 * budget's confidence threshold, so a row with no visible suggestion is a
 * manual-pick row; a hidden best guess is not on the wire.
 */

import type {
  CategorizeBundle,
  CategorizeCounts,
  CategorizeMerchantPanel,
  CategorizeQueue,
  CategorizeQueueRow,
  CategorizeSuggestion,
} from '@/budget/data/api';
import type { MoneyFormat } from '@/domain/format';

import { t } from './i18n';

/** Bundle cards rendered before the "Show N more bundles" row. */
export const BUNDLE_CARD_LIMIT = 8;
/** Chips per row in the one-by-one view (the server caps suggestions at 3). */
export const SUGGESTION_LIMIT = 3;

/** The mock's confidence colour bands: green from 90%, yellow from 70%, grey below. */
export type ConfidenceBand = 'high' | 'mid' | 'low';

export function confidenceBand(confidence: number): ConfidenceBand {
  if (confidence >= 0.9) return 'high';
  if (confidence >= 0.7) return 'mid';
  return 'low';
}

/** The chips the one-by-one view shows, best rank first. */
export function topSuggestions(suggestions: readonly CategorizeSuggestion[]): CategorizeSuggestion[] {
  return suggestions.slice(0, SUGGESTION_LIMIT);
}

export interface BundleView {
  /** Every bundle, most transactions first (the queue order the mock shows). */
  all: CategorizeBundle[];
  shown: CategorizeBundle[];
  hidden: CategorizeBundle[];
  /** Transactions behind the "Show N more bundles" row. */
  hiddenTransactionCount: number;
  /** "Accept all above threshold" files every bundle's transactions. */
  acceptAllCount: number;
  /** Manual-pick rows on this queue page (no usable suggestion), in queue order. */
  manualRows: CategorizeQueueRow[];
  /** Whole-queue size of the manual-pick group. */
  manualCount: number;
}

export function bundleView(queue: CategorizeQueue): BundleView {
  const all = [...queue.bundles].sort((a, b) => b.count - a.count || a.payee.localeCompare(b.payee));
  const shown = all.slice(0, BUNDLE_CARD_LIMIT);
  const hidden = all.slice(BUNDLE_CARD_LIMIT);
  return {
    all,
    shown,
    hidden,
    hiddenTransactionCount: hidden.reduce((sum, bundle) => sum + bundle.count, 0),
    acceptAllCount: all.reduce((sum, bundle) => sum + bundle.count, 0),
    manualRows: queue.rows.filter((row) => row.suggestions.length === 0),
    // The states sum to the queue; above_threshold counts the rows with a
    // visible suggestion, so the rest is exactly the manual group.
    manualCount: Math.max(0, queue.counts.left_to_categorize - queue.counts.above_threshold),
  };
}

/** "480 uncategorized transactions · suggestions ready for 120". */
export function queueSubtitle(counts: Pick<CategorizeCounts, 'left_to_categorize' | 'above_threshold'>): string {
  return t('queue.subtitle', { count: counts.left_to_categorize, ready: counts.above_threshold });
}

/** A bundle's date span, both ends through the active date format. */
export function bundleDateRange(
  bundle: Pick<CategorizeBundle, 'first_date' | 'last_date'>,
  format: Pick<MoneyFormat, 'formatDate'>,
): string {
  return t('bundle.dateRange', {
    first: format.formatDate(bundle.first_date),
    last: format.formatDate(bundle.last_date),
  });
}

/** What an "Accept bundle" press sends: the server resolves rows and the top category. */
export function bundleAcceptInput(bundle: Pick<CategorizeBundle, 'bundle_key' | 'count'>): {
  bundleKey: string;
  expectedCount: number;
} {
  return { bundleKey: bundle.bundle_key, expectedCount: bundle.count };
}

/** Why a row sits in the manual-pick group (its hidden best guess is not on the wire). */
export function manualStateLabel(state: CategorizeQueueRow['state']): string {
  switch (state) {
    case 'below_threshold':
      return t('manual.belowThreshold');
    case 'no_suggestion':
      return t('manual.noSuggestion');
    case 'failed':
      return t('manual.failed');
    case 'not_classified':
      return t('manual.notClassified');
    case 'has_suggestions':
      // A usable suggestion exists: the row belongs to a bundle, not here.
      return '';
  }
}

export type MerchantFactKey = keyof CategorizeMerchantPanel;

export interface MerchantFact {
  key: MerchantFactKey;
  label: string;
  value: string;
}

/** Labels are lazy so the active language is read at render time, never at module load. */
const MERCHANT_LABELS: Record<MerchantFactKey, () => string> = {
  name: () => t('merchant.name'),
  legal_name: () => t('merchant.legalName'),
  cnpj: () => t('merchant.cnpj'),
  business_category: () => t('merchant.businessCategory'),
  operation_type: () => t('merchant.operationType'),
  counterparty_name: () => t('merchant.counterparty'),
};

/**
 * The merchant panel's rows: the facts the bank actually sent, in a fixed
 * order, with null/empty ones omitted. No map: the bank data has no location.
 */
export function merchantFacts(merchant: CategorizeMerchantPanel | null): MerchantFact[] {
  if (!merchant) return [];
  const facts: MerchantFact[] = [];
  for (const key of Object.keys(MERCHANT_LABELS) as MerchantFactKey[]) {
    const value = merchant[key];
    if (value) facts.push({ key, label: MERCHANT_LABELS[key](), value });
  }
  return facts;
}
