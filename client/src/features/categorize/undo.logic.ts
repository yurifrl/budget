/**
 * Pure logic of undoing a Categorize accept: the chunked undo (the contract
 * caps one request at 1000 ids) and the sentence that says exactly what was
 * reversed. Which action Undo reverses is the undo stack in accept.logic.ts.
 */

import { t } from './i18n';

/** The undo contract's cap on `transaction_ids` per request. */
export const UNDO_CHUNK = 1000;

export function chunkIds(ids: readonly string[], size = UNDO_CHUNK): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export interface UndoSummary {
  requested: number;
  /** Ids the server restored. */
  restored: string[];
  /** Ids the server found already restored (a retried chunk that had gone through): they are back. */
  alreadyRestored: string[];
  /** Ids the server left alone (changed since the accept). */
  skipped: number;
  /** Ids in chunks never sent or that failed: still undoable. */
  remaining: string[];
  failed: boolean;
}

export interface UndoChunkResult {
  transaction_ids: readonly string[];
  skipped: readonly { transaction_id?: string; reason?: string }[];
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
  const alreadyRestored: string[] = [];
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += 1) {
    try {
      const result = await send(chunks[i]!);
      restored.push(...result.transaction_ids);
      for (const left of result.skipped) {
        // `no_decision`: never accepted or already undone, i.e. a retry of a chunk that had gone through.
        if (left.reason === 'no_decision' && left.transaction_id) alreadyRestored.push(left.transaction_id);
        else skipped += 1;
      }
    } catch {
      return {
        requested: ids.length,
        restored,
        alreadyRestored,
        skipped,
        remaining: chunks.slice(i).flat(),
        failed: true,
      };
    }
  }
  return { requested: ids.length, restored, alreadyRestored, skipped, remaining: [], failed: false };
}

export interface UndoOutcome {
  /** `ok`: everything asked for was reversed. `problem`: some was not. */
  tone: 'ok' | 'problem';
  text: string;
}

/** What the undo did, in numbers: never a bare "undone" when some rows were not. */
export function undoOutcome(summary: UndoSummary): UndoOutcome {
  const back = summary.restored.length + summary.alreadyRestored.length;
  const left = summary.requested - back;
  if (left <= 0) {
    const text = t('undo.done', { count: back });
    return {
      tone: 'ok',
      text:
        summary.alreadyRestored.length > 0
          ? `${text} ${t('undo.alreadyRestored', { count: summary.alreadyRestored.length })}`
          : text,
    };
  }
  const parts = [t('undo.restored', { count: back, requested: summary.requested })];
  if (summary.skipped > 0) parts.push(t('undo.changedSince', { count: summary.skipped }));
  if (summary.remaining.length > 0) parts.push(t('undo.notReached', { count: summary.remaining.length }));
  return { tone: 'problem', text: parts.join(' ') };
}
