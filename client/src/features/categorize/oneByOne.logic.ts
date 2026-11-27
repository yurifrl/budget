/**
 * Pure logic of the One by one view: the order of the queue pane, which row is
 * in focus after rows leave the queue, the progress counter and the labels the
 * pane shows. No React; the hook owns state and key events.
 */

import type { CategorizeCounts, CategorizeQueueRow } from '@/budget/data/api';

import { t } from './i18n';
import { manualStateLabel } from './queue.logic';
import { transferHeading, type TransferItem } from './transfer.logic';

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

/**
 * The pane's counter: the queue's own rows still to answer and, beside them,
 * the transfer answers its read lists. Both numbers come from their reads, so
 * the counter always adds what the header adds; each names its own noun, since
 * the catalog pluralizes on one `count` per message.
 */
export function queueCounterLabel(queueLeft: number, answers: number): string {
  const left = t('one.queueLeft', { count: queueLeft });
  if (answers <= 0) return left;
  return t('one.queueLeftMixed', { left, answers: t('queue.answers', { count: answers }) });
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

/**
 * One line of the pane: a queue row, or a Jev transfer answer. Both carry the
 * transaction's id, so focus resolution and the filed lines work on either.
 */
export type OneEntry =
  | { kind: 'queue'; transaction_id: string; row: CategorizeQueueRow }
  | { kind: 'transfer'; transaction_id: string; item: TransferItem };

/**
 * The pane's order: Jev's transfer answers first (highest confidence first, so
 * the surest money movement is answered before the queue), then the queue rows
 * in their own order. Stable for a re-read of the same data.
 */
export function entriesOf(
  rows: readonly CategorizeQueueRow[],
  transfers: readonly TransferItem[],
): OneEntry[] {
  const surest = [...transfers].sort((a, b) => b.confidence - a.confidence);
  // The server answers a row as a transfer OR as a category, never both; a
  // stale read of the other list (refetched a moment later) must not list it
  // twice, and the transfer answer is the more specific one.
  const answered = new Set(surest.map((item) => item.transaction_id));
  return [
    ...surest.map((item): OneEntry => ({ kind: 'transfer', transaction_id: item.transaction_id, item })),
    ...rows
      .filter((row) => !answered.has(row.transaction_id))
      .map((row): OneEntry => ({ kind: 'queue', transaction_id: row.transaction_id, row })),
  ];
}

/** The second line of a transfer line: its date and the account it names. */
export function transferSubline(heading: string, formattedDate: string): string {
  return `${formattedDate} · ${heading}`;
}

/** "Transfer · Savings" for the dimmed line a filed transfer leaves behind. */
export function transferFiledTo(accountName: string): string {
  return t('transfer.filedTo', { account: accountName });
}

/**
 * What a pane line shows: the payee, the second line, the amount and the
 * certainty to show beside it (null when the line has none to show). The date
 * formatter comes in so a pure test can pin the sentence without a UI provider.
 */
export function paneLine(
  entry: OneEntry,
  formatDate: (isoDate: string) => string,
): { payee: string; subline: string; amount: number; confidence: number | null } {
  if (entry.kind === 'transfer') {
    const { item } = entry;
    return {
      payee: item.payee.trim() || t('row.unnamed'),
      subline: transferSubline(transferHeading(item), formatDate(item.date)),
      amount: item.amount,
      confidence: item.confidence,
    };
  }
  const { row } = entry;
  const top = row.suggestions[0];
  return {
    payee: row.payee?.trim() || row.raw_bank_description?.trim() || t('row.unnamed'),
    subline: queueRowSubline(row, formatDate(row.date)),
    amount: row.amount,
    confidence: top ? top.confidence : null,
  };
}

/**
 * The explanation under "no suggestion for this one", or null when the row's
 * state has no words of its own (its only suggestions were hidden). An empty
 * line is not an explanation: the card leaves it out instead of reserving it.
 */
export function noSuggestionHint(state: CategorizeQueueRow['state']): string | null {
  const what = manualStateLabel(state);
  return what ? t('one.stateHint', { state: what }) : null;
}

/** A suggestion's rank as the number key that files it (1..3). */
export function keyHint(index: number): string {
  return String(index + 1);
}

/**
 * A line this visit filed or left out: it stays in the queue pane as a dimmed
 * "✓ filed to X" line. Display fields only, so a transfer answer (which is not
 * a queue row) leaves the same kind of line as a category filing.
 */
export interface FiledEntry {
  transaction_id: string;
  /** The payee as the pane writes it; null when the row has none. */
  payee: string | null;
  /** Integer milliunits. */
  amount: number;
  /** YYYY-MM-DD. */
  date: string;
  /** "filed to Transport" / "left uncategorized", already translated. */
  text: string;
}

/** Filed lines kept for the visit (the oldest scroll away first). */
export const FILED_KEPT = 30;

/** The dimmed line a finished pane line leaves behind: a filing, a transfer, a skip. */
export function filedLine(
  source: Pick<CategorizeQueueRow, 'transaction_id' | 'payee' | 'amount' | 'date'> & {
    raw_bank_description?: string | null;
  },
  text: string,
): FiledEntry {
  return {
    transaction_id: source.transaction_id,
    payee: source.payee?.trim() || source.raw_bank_description?.trim() || null,
    amount: source.amount,
    date: source.date,
    text,
  };
}

/** Add (or replace) the line for one transaction, newest last, bounded. */
export function recordFiled(entries: readonly FiledEntry[], entry: FiledEntry, keep = FILED_KEPT): FiledEntry[] {
  const next = entries.filter((e) => e.transaction_id !== entry.transaction_id);
  next.push(entry);
  return next.slice(-keep);
}

/** The dimmed line one pane entry leaves behind, whichever kind it is. */
export function filedLineOf(entry: OneEntry, text: string): FiledEntry {
  return entry.kind === 'transfer'
    ? filedLine(
        {
          transaction_id: entry.item.transaction_id,
          payee: entry.item.payee,
          amount: entry.item.amount,
          date: entry.item.date,
        },
        text,
      )
    : filedLine(entry.row, text);
}

/** Drop the lines of rows that came back (undone, cancelled or failed). */
export function dropFiled(entries: readonly FiledEntry[], ids: readonly string[]): FiledEntry[] {
  if (ids.length === 0) return [...entries];
  const gone = new Set(ids);
  return entries.filter((e) => !gone.has(e.transaction_id));
}


/** "filed to Transport" for a row filed with a category. */
export function filedToText(categoryName: string): string {
  return t('one.filedTo', { category: categoryName });
}

