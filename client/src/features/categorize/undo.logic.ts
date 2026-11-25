/**
 * Pure logic of undoing a Categorize action: which action "Undo" and the Z key
 * reverse (always the one the person did LAST, whichever response lands
 * first), the chunked undo (the contract caps one request at 1000 ids) and the
 * sentence that says exactly what was reversed.
 */

import { t } from './i18n';

/** The undo contract's cap on `transaction_ids` per request. */
export const UNDO_CHUNK = 1000;

/** The action Undo/Z would reverse. A skip is only undoable while it is still pending. */
export interface UndoTarget {
  /** Press order: the highest is the latest action. */
  seq: number;
  kind: 'accept' | 'skip';
  label: string;
  /** Known up front for a single row, filled from the server's answer for batches. */
  transactionIds: string[];
  confirmed: boolean;
}

export function beginTarget(
  seq: number,
  kind: UndoTarget['kind'],
  label: string,
  transactionIds: string[],
): UndoTarget {
  return { seq, kind, label, transactionIds, confirmed: kind === 'skip' };
}

/**
 * The server answered for action `seq`: it becomes the confirmed target only
 * if it is still the latest one. A late answer for an earlier press changes
 * nothing, so Z undoes the last key press, not the last response.
 */
export function confirmTarget(
  current: UndoTarget | null,
  seq: number,
  transactionIds: string[],
): UndoTarget | null {
  if (!current || current.seq !== seq) return current;
  return { ...current, transactionIds, confirmed: true };
}

/** Action `seq` failed: if it was the target there is nothing to undo any more. */
export function failTarget(current: UndoTarget | null, seq: number): UndoTarget | null {
  return current && current.seq === seq ? null : current;
}

export function chunkIds(ids: readonly string[], size = UNDO_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export interface UndoSummary {
  requested: number;
  /** Ids the server restored. */
  restored: string[];
  /** Ids the server left alone (changed since the accept). */
  skipped: number;
  /** Ids in chunks never sent or that failed: still undoable. */
  remaining: string[];
  failed: boolean;
}

export interface UndoChunkResult {
  transaction_ids: readonly string[];
  skipped: readonly unknown[];
}

/**
 * Undo `ids` one chunk at a time. A failed chunk stops the run: it and every
 * later chunk stay in `remaining`, so the person can try again.
 */
export async function undoInChunks(
  ids: readonly string[],
  send: (chunk: string[]) => Promise<UndoChunkResult>,
  size = UNDO_CHUNK,
): Promise<UndoSummary> {
  const chunks = chunkIds(ids, size);
  const restored: string[] = [];
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    try {
      const result = await send(chunks[i]!);
      restored.push(...result.transaction_ids);
      skipped += result.skipped.length;
    } catch {
      return { requested: ids.length, restored, skipped, remaining: chunks.slice(i).flat(), failed: true };
    }
  }
  return { requested: ids.length, restored, skipped, remaining: [], failed: false };
}

export interface UndoOutcome {
  /** `ok`: everything asked for was reversed. `problem`: some was not. */
  tone: 'ok' | 'problem';
  text: string;
}

/** What the undo did, in numbers: never a bare "undone" when some rows were not. */
export function undoOutcome(summary: UndoSummary): UndoOutcome {
  const restored = summary.restored.length;
  const left = summary.requested - restored;
  if (left <= 0) return { tone: 'ok', text: t('undo.done', { count: restored }) };
  const parts = [t('undo.restored', { count: restored, requested: summary.requested })];
  if (summary.skipped > 0) parts.push(t('undo.changedSince', { count: summary.skipped }));
  if (summary.remaining.length > 0) parts.push(t('undo.notReached', { count: summary.remaining.length }));
  return { tone: 'problem', text: parts.join(' ') };
}
