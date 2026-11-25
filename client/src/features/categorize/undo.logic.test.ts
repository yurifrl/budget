import { describe, expect, test } from 'bun:test';

import { chunkIds, undoInChunks, undoOutcome, UNDO_CHUNK, type UndoSummary } from './undo.logic';

const ids = (n: number, from = 0) => Array.from({ length: n }, (_, i) => `t${from + i}`);
const summary = (over: Partial<UndoSummary>): UndoSummary => ({
  requested: 0,
  restored: [],
  alreadyRestored: [],
  skipped: 0,
  remaining: [],
  failed: false,
  ...over,
});

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
    const result = await undoInChunks(ids(1500), async (chunk) => {
      sizes.push(chunk.length);
      return ok(chunk);
    });
    expect(sizes).toEqual([1000, 500]);
    expect(result).toEqual(summary({ requested: 1500, restored: ids(1500) }));
  });

  test('counts what the server left alone because it changed', async () => {
    const result = await undoInChunks(ids(3), async (chunk) => ({
      transaction_ids: chunk.slice(0, 2),
      skipped: [{ transaction_id: chunk[2], reason: 'category_changed' }],
    }));
    expect(result.restored).toEqual(['t0', 't1']);
    expect(result.skipped).toBe(1);
    expect(result.alreadyRestored).toEqual([]);
  });

  test('a retried chunk that had gone through is "already restored", not "changed since"', async () => {
    const result = await undoInChunks(ids(3), async (chunk) => ({
      transaction_ids: [],
      skipped: chunk.map((id) => ({ transaction_id: id, reason: 'no_decision' })),
    }));
    expect(result.alreadyRestored).toEqual(ids(3));
    expect(result.skipped).toBe(0);
  });

  test('a failed chunk stops the run and keeps it and the later chunks undoable', async () => {
    let call = 0;
    const result = await undoInChunks(
      ids(25),
      async (chunk) => {
        call += 1;
        if (call === 2) throw new Error('offline');
        return ok(chunk);
      },
      10,
    );
    expect(call).toBe(2);
    expect(result.restored).toEqual(ids(10));
    expect(result.remaining).toEqual(ids(15, 10));
    expect(result.failed).toBe(true);
  });
});

describe('undoOutcome', () => {
  test('everything reversed is ok', () => {
    expect(undoOutcome(summary({ requested: 3, restored: ids(3) }))).toEqual({
      tone: 'ok',
      text: 'Undid 3 transactions.',
    });
  });

  test('rows already restored by an earlier attempt are said, and still count as back', () => {
    const outcome = undoOutcome(summary({ requested: 3, restored: ids(1), alreadyRestored: ids(2, 1) }));
    expect(outcome).toEqual({ tone: 'ok', text: 'Undid 3 transactions. 2 of them were already restored.' });
  });

  test('rows the server skipped because they changed are never reported as success', () => {
    const outcome = undoOutcome(summary({ requested: 5, restored: ids(3), skipped: 2 }));
    expect(outcome.tone).toBe('problem');
    expect(outcome.text).toBe('Undid 3 of 5 transactions. 2 changed since and were left as they are.');
  });

  test('chunks that could not be reached are counted', () => {
    const outcome = undoOutcome(
      summary({ requested: 2500, restored: ids(1000), remaining: ids(1500, 1000), failed: true }),
    );
    expect(outcome.tone).toBe('problem');
    expect(outcome.text).toBe('Undid 1000 of 2500 transactions. 1500 could not be undone right now: try Undo again.');
  });
});
