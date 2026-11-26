/**
 * Pure view logic of the Categorize page: the threshold control, the
 * category search options and the small labels shared by
 * the accept flow. Wire-typed (feature-local); money formatting comes from the
 * caller's `useMoneyFormat()`.
 */

import type {
  CategorizeBundle,
  CategorizeQueueRow,
} from '@/budget/data/api';
import type { BundleRow, CategoryRow, GroupRow } from '@/budget/data/rows';
import { milliToCents } from '@/budget/data/mapping';

import { t } from './i18n';

/** Confidence threshold control: integer percent, 0..100. */
export function thresholdPercent(value: number): number {
  return Math.round(Math.max(0, Math.min(1, value)) * 100);
}

/** A pointer position on the threshold track → the 0..1 value it sets. */
export function thresholdFromX(x: number, width: number): number {
  if (width <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, x / width));
  return Math.round(ratio * 100) / 100;
}

export function thresholdLabel(value: number): string {
  return t('header.thresholdValue', { percent: thresholdPercent(value) });
}

export interface CategoryOption {
  id: string;
  label: string;
  /** Owning group name, shown under the label in the picker. */
  sub: string;
}

/** A category chosen in the search picker: id plus the label to name it in a toast. */
export interface PickedCategory {
  id: string;
  label: string;
}

/**
 * The categories a transaction may be filed into: not hidden, internal or
 * deleted, nor inside a hidden, deleted, internal or credit-card-payment group
 * (what the server accepts as assignable; it refuses the rest with a 400). Labels carry
 * the bundle when the category belongs to one.
 */
export function categoryOptions(
  categories: readonly CategoryRow[],
  groups: readonly GroupRow[],
  bundles: readonly BundleRow[],
): CategoryOption[] {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const bundleById = new Map(bundles.map((b) => [b.id, b.name]));
  return categories
    .filter((category) => !category.deleted && !category.hidden && !category.internal)
    .filter((category) => {
      const group = groupById.get(category.group_id);
      return !group || (!group.deleted && !group.hidden && !group.internal && !group.is_credit_card_payments);
    })
    .map((category) => {
      const bundle = category.bundle_id ? bundleById.get(category.bundle_id) : undefined;
      return {
        id: category.id,
        label: bundle ? `${bundle} › ${category.name}` : category.name,
        sub: groupById.get(category.group_id)?.name ?? '',
      };
    });
}

/** The bundle accept was refused because its row count moved (409). */
export function isBundleChanged(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'categorize_bundle_changed'
  );
}

/**
 * What to tell the person when a bundle accept is refused because its count
 * moved. The list is already refreshing when this shows, so the sentence says
 * so (the server's own text asks for a page reload).
 */
export function bundleChangedMessage(error: unknown): string {
  const params = typeof error === 'object' && error !== null && 'params' in error ? error.params : null;
  const read = (key: string): number | null => {
    const value = typeof params === 'object' && params !== null ? (params as Record<string, unknown>)[key] : null;
    return typeof value === 'number' ? value : null;
  };
  const expected = read('expected');
  const actual = read('actual');
  return expected !== null && actual !== null
    ? t('error.bundleChanged', { expected, actual })
    : t('error.bundleChangedNoCounts');
}

/** "Uber · R$ 18,90" for the undo toast; payee (or raw bank text) and amount. */
export function rowSubject(
  row: Pick<CategorizeQueueRow, 'payee' | 'raw_bank_description' | 'amount'>,
  formatMoney: (cents: number) => string,
): string {
  const who = row.payee?.trim() || row.raw_bank_description?.trim() || t('row.unnamed');
  return `${who} · ${formatMoney(milliToCents(row.amount))}`;
}

/** "Uber · 9 transactions → Transport" for an accepted bundle. */
export function bundleToastLabel(bundle: Pick<CategorizeBundle, 'payee' | 'count' | 'suggestion'>): string {
  return t('toast.bundle', {
    payee: bundle.payee,
    count: bundle.count,
    category: bundle.suggestion.category_name,
  });
}

/**
 * The page is reloading after a threshold change: from the save until the
 * queue read that follows it lands (or fails), the old bundles and rows must
 * not be actionable, because they were cut at the old threshold.
 */
export function thresholdReloading({
  saving,
  stamp,
  fulfilledAt,
  failed,
}: {
  saving: boolean;
  /** `fulfilledTimeStamp` of the queue read when the threshold was saved; null when none is pending. */
  stamp: number | null;
  fulfilledAt: number;
  failed: boolean;
}): boolean {
  if (saving) return true;
  return stamp !== null && fulfilledAt <= stamp && !failed;
}

/**
 * The identity of the Categorize page's state: one budget. The screen is keyed
 * by it, so switching budget in place remounts the page (queue focus, filed
 * lines, undo stack, pending skips and their timers, toasts all start fresh) and
 * every request carries the budget its action was taken in.
 */
export function pageKey(budgetId: string | null): string {
  return budgetId ?? 'no-budget';
}

/**
 * Why a skip send failed. `refused`: the server says the row no longer needs a
 * category (categorized elsewhere, already decided): it leaves the strip with a
 * note. `rejected`: 400, 403 or 404, the request can never succeed (not allowed,
 * gone): it leaves the strip with a note instead of being retried forever.
 * `retry`: anything else (network, 5xx): the row stays in the strip.
 */
export function skipFailureKind(error: unknown): 'refused' | 'rejected' | 'retry' {
  const read = (key: string): unknown =>
    typeof error === 'object' && error !== null && key in error ? (error as Record<string, unknown>)[key] : null;
  const code = read('code');
  if (code === 'categorize_already_categorized' || code === 'categorize_not_needing_category') return 'refused';
  const status = read('status');
  return status === 400 || status === 403 || status === 404 ? 'rejected' : 'retry';
}

/**
 * Strip rows whose transaction has left the queue. The queue read holds one
 * page of rows, so a row missing from it is only known to be gone when the page
 * is the WHOLE queue; beyond that it may simply be past the page, and the row
 * stays until Done (whose 409 settles it).
 */
export function rowsGoneFromQueue(
  stripIds: readonly string[],
  loadedIds: ReadonlySet<string>,
  queueSize: number,
  loadedCount: number,
): string[] {
  if (loadedCount < queueSize) return [];
  return stripIds.filter((id) => !loadedIds.has(id));
}
