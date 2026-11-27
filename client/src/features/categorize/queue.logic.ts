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

import type { LeavingMeta } from './accept.logic';
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

/**
 * A bundle as the page shows it: `count` and `total` leave out the rows waiting
 * in the "Leaving uncategorized" strip. `serverCount` is what the server counts,
 * which is what a bundle accept must quote back.
 */
export interface ShownBundle extends CategorizeBundle {
  serverCount: number;
}

export interface BundleView {
  /** Every bundle, most transactions first (the queue order the mock shows). */
  all: ShownBundle[];
  shown: ShownBundle[];
  hidden: ShownBundle[];
  /** Transactions behind the "Show N more bundles" row. */
  hiddenTransactionCount: number;
  /** "Accept all above threshold" files every bundle's transactions. */
  acceptAllCount: number;
  /** Manual-pick rows on this queue page (no usable suggestion), in queue order. */
  manualRows: CategorizeQueueRow[];
  /** Whole-queue size of the manual-pick group. */
  manualCount: number;
}

/**
 * The bundles without the rows in the strip: a row belongs to the bundle with
 * its payee and its top suggestion; a bundle with nothing left is dropped.
 */
export function bundlesWithoutLeaving(
  bundles: readonly CategorizeBundle[],
  leaving: readonly LeavingMeta[],
): ShownBundle[] {
  return bundles.flatMap((bundle) => {
    const mine = leaving.filter(
      (row) => row.payeeId === bundle.payee_id && row.topCategoryId === bundle.suggestion.category_id,
    );
    const count = bundle.count - mine.length;
    if (count <= 0) return [];
    return [
      {
        ...bundle,
        count,
        total: bundle.total - mine.reduce((sum, row) => sum + row.amount, 0),
        serverCount: bundle.count,
      },
    ];
  });
}

/** The header counts without the rows in the strip (they are still counted by the server until Done). */
export function countsWithoutLeaving<T extends Pick<CategorizeCounts, 'left_to_categorize' | 'above_threshold'>>(
  counts: T,
  leaving: readonly LeavingMeta[],
): T {
  const suggested = leaving.filter((row) => row.topCategoryId !== null).length;
  return {
    ...counts,
    left_to_categorize: Math.max(0, counts.left_to_categorize - leaving.length),
    above_threshold: Math.max(0, counts.above_threshold - suggested),
  };
}

export function bundleView(queue: CategorizeQueue, leaving: readonly LeavingMeta[] = []): BundleView {
  const counts = countsWithoutLeaving(queue.counts, leaving);
  const all = bundlesWithoutLeaving(queue.bundles, leaving).sort(
    (a, b) => b.count - a.count || a.payee.localeCompare(b.payee),
  );
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
    manualCount: Math.max(0, counts.left_to_categorize - counts.above_threshold),
  };
}

/**
 * "480 uncategorized transactions · suggestions ready for 120". Jev's transfer
 * answers are counted apart: they are not rows of the category queue. Each
 * number names its own noun, so each is its own message and the subtitle joins
 * them — the catalog picks one plural branch per message, from its `count`.
 */
export function queueSubtitle(
  counts: Pick<CategorizeCounts, 'left_to_categorize' | 'above_threshold'>,
  transfers = 0,
): string {
  if (transfers > 0) {
    return t('queue.subtitleMixed', {
      left: t('queue.left', { count: counts.left_to_categorize }),
      answers: t('queue.answers', { count: transfers }),
      ready: counts.above_threshold,
    });
  }
  return t('queue.subtitle', { count: counts.left_to_categorize, ready: counts.above_threshold });
}

/**
 * A bundle's date span through the active date format: day and month when both
 * ends fall in the same year ("02/10 – 21/11", the mock), the full dates when
 * the span crosses a year so it stays unambiguous.
 */
export function bundleDateRange(
  bundle: Pick<CategorizeBundle, 'first_date' | 'last_date'>,
  format: Pick<MoneyFormat, 'formatDate' | 'formatDateShort'>,
): string {
  const sameYear = bundle.first_date.slice(0, 4) === bundle.last_date.slice(0, 4);
  const show = sameYear ? format.formatDateShort : format.formatDate;
  return t('bundle.dateRange', { first: show(bundle.first_date), last: show(bundle.last_date) });
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
 * order, with null/empty ones omitted (and the trade name when it equals the
 * payee). No map: the bank data has no location.
 */
export function merchantFacts(merchant: CategorizeMerchantPanel | null, payee?: string | null): MerchantFact[] {
  if (!merchant) return [];
  const facts: MerchantFact[] = [];
  const title = payee?.trim().toLowerCase();
  for (const key of Object.keys(MERCHANT_LABELS) as MerchantFactKey[]) {
    const value = merchant[key];
    if (!value) continue;
    // The trade name only adds something when it is not the title already shown.
    if (key === 'name' && title && value.trim().toLowerCase() === title) continue;
    facts.push({ key, label: MERCHANT_LABELS[key](), value });
  }
  return facts;
}
