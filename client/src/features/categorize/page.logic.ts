/**
 * Pure view logic of the Categorize page: the threshold control, the run
 * header states, the category search options and the small labels shared by
 * the accept flow. Wire-typed (feature-local); money formatting comes from the
 * caller's `useMoneyFormat()`.
 */

import type {
  CategorizeBundle,
  CategorizeCounts,
  CategorizeQueueRow,
  CategorizeRunStatus,
} from '@/budget/data/api';
import type { BundleRow, CategoryRow, GroupRow } from '@/budget/data/rows';
import { milliToCents } from '@/budget/data/mapping';
import type { MoneyFormat } from '@/domain/format';

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

export type RunHeaderKind = 'active' | 'unavailable' | 'all_classified' | 'finished' | 'never';

export interface RunHeaderView {
  kind: RunHeaderKind;
  title: string;
  detail: string;
  /** Active run progress, 0..1 (0 while queued or idle). */
  fraction: number;
}

function runDate(iso: string): string {
  return iso.slice(0, 10);
}

function lastRunLine(run: CategorizeRunStatus['last_finished'], format: Pick<MoneyFormat, 'formatDate'>): string | null {
  if (!run) return null;
  const date = run.finished_at ?? run.created_at;
  return t('run.lastShort', { date: format.formatDate(runDate(date)), suggested: run.suggested ?? 0 });
}

/** The header's run block: live progress, why AI is off, or the last run. */
export function runHeaderView(
  status: CategorizeRunStatus,
  counts: Pick<CategorizeCounts, 'left_to_categorize' | 'not_classified'>,
  format: Pick<MoneyFormat, 'formatDate'>,
): RunHeaderView {
  const active = status.active;
  if (active) {
    return {
      kind: 'active',
      title: active.total > 0 ? t('run.classifying', { done: active.done, total: active.total }) : t('run.starting'),
      detail: t('run.activeHint'),
      fraction: active.total > 0 ? Math.max(0, Math.min(1, active.done / active.total)) : 0,
    };
  }
  if (!status.ai.available) {
    return { kind: 'unavailable', title: t('run.unavailable'), detail: aiReasonMessage(status.ai.reason), fraction: 0 };
  }
  const last = lastRunLine(status.last_finished, format);
  if (counts.left_to_categorize === 0) {
    return { kind: 'all_classified', title: t('run.nothingLeft'), detail: last ?? t('run.neverHint'), fraction: 0 };
  }
  if (counts.not_classified === 0) {
    return {
      kind: 'all_classified',
      title: t('run.allClassified', { count: counts.left_to_categorize }),
      detail: last ?? t('run.nextRun'),
      fraction: 0,
    };
  }
  if (last) return { kind: 'finished', title: last, detail: t('run.nextRun'), fraction: 0 };
  return { kind: 'never', title: t('run.never'), detail: t('run.neverHint'), fraction: 0 };
}

/** One sentence for every reason a run cannot start (the status carries it). */
export function aiReasonMessage(reason: CategorizeRunStatus['ai']['reason']): string {
  switch (reason) {
    case 'own_key_required':
      return t('run.reason.ownKey');
    case 'shared_key_missing':
      return t('run.reason.sharedKey');
    case 'shared_model_missing':
      return t('run.reason.sharedModel');
    case 'encryption_missing':
      return t('run.reason.encryption');
    case 'unreadable':
      return t('run.reason.unreadable');
    case 'no_model':
      return t('run.reason.noModel');
    default:
      return t('run.reason.unknown');
  }
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
 * The categories a transaction may be filed into: not hidden, internal,
 * deleted, nor inside an internal or credit-card-payment group. Labels carry
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
      return !group || (!group.deleted && !group.internal && !group.is_credit_card_payments);
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
