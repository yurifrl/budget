/**
 * Pure logic of the One by one view: the order of the queue pane, which row is
 * in focus after rows leave the queue, the progress counter and the labels the
 * pane shows. No React; the hook owns state and key events.
 */

import type { CategorizeCounts, CategorizeQueueRow } from '@/budget/data/api';

import { t } from './i18n';
import { manualStateLabel } from './queue.logic';

/** The row's best suggestion confidence; -1 when it has none. */
function topConfidence(row: Pick<CategorizeQueueRow, 'suggestions'>): number {
  return row.suggestions.reduce((best, s) => Math.max(best, s.confidence), -1);
}

/**
 * "Highest confidence first": rows with a suggestion by their best
 * confidence, then the manual-pick rows; ties keep the server order (newest
 * first). Stable, so a re-read of the same queue keeps its order.
 */
export function orderQueue<T extends Pick<CategorizeQueueRow, 'suggestions'>>(rows: readonly T[]): T[] {
  return rows
    .map((row, index) => ({ row, index, top: topConfidence(row) }))
    .sort((a, b) => b.top - a.top || a.index - b.index)
    .map((entry) => entry.row);
}

export interface Focus<T> {
  row: T | null;
  index: number;
}

/**
 * The row in focus: the one with `focusedId` while it is still listed, else the
 * row that now sits where the old one was (a filed row hands focus to the next
 * one), clamped to the end of the list.
 */
export function resolveFocus<T extends { transaction_id: string }>(
  rows: readonly T[],
  focusedId: string | null,
  lastIndex: number,
): Focus<T> {
  if (rows.length === 0) return { row: null, index: 0 };
  const found = focusedId ? rows.findIndex((row) => row.transaction_id === focusedId) : -1;
  const index = found >= 0 ? found : Math.max(0, Math.min(lastIndex, rows.length - 1));
  return { row: rows[index] ?? null, index };
}

/**
 * Rows still to do: the queue's size minus the optimistically hidden rows the
 * counts have not caught up with yet (they are still in the page).
 */
export function remainingCount(
  counts: Pick<CategorizeCounts, 'left_to_categorize'> | undefined,
  pageRows: readonly Pick<CategorizeQueueRow, 'transaction_id'>[],
  hiddenIds: ReadonlySet<string>,
): number {
  if (!counts) return 0;
  const stillCounted = pageRows.filter((row) => hiddenIds.has(row.transaction_id)).length;
  return Math.max(0, counts.left_to_categorize - stillCounted);
}

export interface ProgressView {
  /** 1-based position of the row in focus; equals total + 1 never (clamped). */
  position: number;
  total: number;
  fraction: number;
}

/** "37 of 212": rows done this visit plus what is left. */
export function progressView(done: number, remaining: number): ProgressView {
  const total = done + remaining;
  if (total === 0) return { position: 0, total: 0, fraction: 0 };
  return {
    position: Math.min(done + 1, total),
    total,
    fraction: Math.max(0, Math.min(1, done / total)),
  };
}

export function progressLabel(progress: ProgressView): string {
  return t('one.progress', { position: progress.position, total: progress.total });
}

/** The second line of a queue-pane row: its date and the best category or why it has none. */
export function queueRowSubline(
  row: Pick<CategorizeQueueRow, 'suggestions' | 'state'>,
  formattedDate: string,
): string {
  const top = row.suggestions[0];
  const what = top ? top.category_name : manualStateLabel(row.state);
  return what ? `${formattedDate} · ${what}` : formattedDate;
}

/** A suggestion's rank as the number key that files it (1..3). */
export function keyHint(index: number): string {
  return String(index + 1);
}
