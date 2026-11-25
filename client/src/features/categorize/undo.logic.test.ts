import { describe, expect, test } from 'bun:test';

import {
  beginTarget,
  chunkIds,
  confirmTarget,
  failTarget,
  undoInChunks,
  undoOutcome,
  UNDO_CHUNK,
} from './undo.logic';

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `t${from + i}`);

describe('chunkIds', () => {
  test('splits at the contract cap', () => {
    expect(UNDO_CHUNK).toBe(1000);
    const chunks = chunkIds(ids(2500));
    expect(chunks.map((c) => c.length)).toEqual([1000, 1000, 500]);
    expect(chunks.flat()).toEqual(ids(2500));
  });

  test('no ids, no requests; exactly the cap is one chunk', () => {
    expect(chunkIds([])).toEqual([]);
    expect(chunkIds(ids(1000)).length).toBe(1);
  });
});

describe('undoInChunks', () => {
  const ok = async (chunk: string[]) => ({ transaction_ids: chunk, skipped: [] });

  test('1500 ids go out as 1000 + 500 and are all restored', async () => {
    const sizes: number[] = [];
    const summary = await undoInChunks(ids(1500), async (chunk) => {
      sizes.push(chunk.length);
      return ok(chunk);
    });
    expect(sizes).toEqual([1000, 500]);
    expect(summary).toEqual({ requested: 1500, restored: ids(1500), skipped: 0, remaining: [], failed: false });
  });

  test('counts what the server left alone', async () => {
    const summary = await undoInChunks(ids(3), async (chunk) => ({
      transaction_ids: chunk.slice(0, 2),
      skipped: [{ transaction_id: chunk[2], reason: 'category_changed' }],
    }));
    expect(summary.restored).toEqual(['t0', 't1']);
    expect(summary.skipped).toBe(1);
    expect(summary.failed).toBe(false);
  });

  test('a failed chunk stops the run and keeps it and the later chunks undoable', async () => {
    let call = 0;
    const summary = await undoInChunks(
      ids(25),
      async (chunk) => {
        call += 1;
        if (call === 2) throw new Error('offline');
        return ok(chunk);
      },
      10,
    );
    expect(call).toBe(2);
    expect(summary.restored).toEqual(ids(10));
    expect(summary.remaining).toEqual(ids(15, 10));
    expect(summary.failed).toBe(true);
  });
});

describe('undoOutcome', () => {
  test('everything reversed is ok', () => {
    const outcome = undoOutcome({ requested: 3, restored: ids(3), skipped: 0, remaining: [], failed: false });
    expect(outcome).toEqual({ tone: 'ok', text: 'Undid 3 transactions.' });
  });

  test('rows the server skipped are said, never reported as success', () => {
    const outcome = undoOutcome({ requested: 5, restored: ids(3), skipped: 2, remaining: [], failed: false });
    expect(outcome.tone).toBe('problem');
    expect(outcome.text).toBe('Undid 3 of 5 transactions. 2 changed since and were left as they are.');
  });

  test('chunks that could not be reached are counted', () => {
    const outcome = undoOutcome({ requested: 2500, restored: ids(1000), skipped: 0, remaining: ids(1500, 1000), failed: true });
    expect(outcome.tone).toBe('problem');
    expect(outcome.text).toBe('Undid 1000 of 2500 transactions. 1500 could not be undone right now: try Undo again.');
  });
});

describe('undo target', () => {
  test('a late answer for an earlier press does not replace the latest target', () => {
    const a = beginTarget(1, 'accept', 'A', ['a']);
    const b = beginTarget(2, 'accept', 'B', ['b']);
    // B is the target; A's response lands afterwards.
    expect(confirmTarget(b, 1, ['a'])).toBe(b);
    expect(confirmTarget(a, 1, ['a'])?.confirmed).toBe(true);
  });

  test('the latest answer fills in the ids a batch did not know up front', () => {
    const batch = beginTarget(3, 'accept', 'Batch', []);
    expect(batch.confirmed).toBe(false);
    expect(confirmTarget(batch, 3, ['x', 'y'])).toEqual({ ...batch, transactionIds: ['x', 'y'], confirmed: true });
  });

  test('a failure clears only its own target', () => {
    const a = beginTarget(1, 'accept', 'A', ['a']);
    expect(failTarget(a, 1)).toBeNull();
    expect(failTarget(a, 2)).toBe(a);
    expect(failTarget(null, 1)).toBeNull();
  });

  test('a pending skip starts confirmed: nothing was sent yet', () => {
    expect(beginTarget(4, 'skip', 'S', ['s']).confirmed).toBe(true);
  });
});
