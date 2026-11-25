import { describe, expect, test } from 'bun:test';

import {
  orderQueue,
  progressLabel,
  progressView,
  queueRowSubline,
  remainingCount,
  resolveFocus,
} from './oneByOne.logic';

const sugg = (confidence: number, name = 'Fuel') => ({
  category_id: `c-${name}`,
  category_name: name,
  confidence,
  reason: null,
  source: 'ai' as const,
});
const row = (id: string, confidences: number[], state: 'has_suggestions' | 'no_suggestion' = 'has_suggestions') => ({
  transaction_id: id,
  suggestions: confidences.map((c) => sugg(c)),
  state,
});

describe('orderQueue', () => {
  test('highest confidence first, rows without a suggestion last, server order on ties', () => {
    const ordered = orderQueue([
      row('manual-1', [], 'no_suggestion'),
      row('a', [0.83]),
      row('b', [0.94, 0.04]),
      row('c', [0.83]),
      row('manual-2', [], 'no_suggestion'),
    ]);
    expect(ordered.map((r) => r.transaction_id)).toEqual(['b', 'a', 'c', 'manual-1', 'manual-2']);
  });

  test('does not mutate its input', () => {
    const input = [row('x', []), row('y', [0.9])];
    orderQueue(input);
    expect(input.map((r) => r.transaction_id)).toEqual(['x', 'y']);
  });
});

describe('resolveFocus', () => {
  const rows = [{ transaction_id: 'a' }, { transaction_id: 'b' }, { transaction_id: 'c' }];

  test('keeps the focused row while it is listed, wherever it moved', () => {
    expect(resolveFocus(rows, 'b', 0)).toEqual({ row: rows[1], index: 1 });
  });

  test('a filed row hands focus to the row now at its place', () => {
    const after = rows.filter((r) => r.transaction_id !== 'b');
    expect(resolveFocus(after, 'b', 1)).toEqual({ row: after[1], index: 1 });
  });

  test('filing the last row focuses the new last one', () => {
    const after = rows.slice(0, 2);
    expect(resolveFocus(after, 'c', 2)).toEqual({ row: after[1], index: 1 });
  });

  test('no id yet focuses the first row; an empty queue focuses nothing', () => {
    expect(resolveFocus(rows, null, 0).row).toBe(rows[0]);
    expect(resolveFocus([], 'a', 3)).toEqual({ row: null, index: 0 });
  });
});

describe('remainingCount and progress', () => {
  test('rows hidden but still counted by the server are not remaining', () => {
    const pageRows = [{ transaction_id: 'a' }, { transaction_id: 'b' }];
    expect(remainingCount({ left_to_categorize: 212 }, pageRows, new Set(['a']))).toBe(211);
    expect(remainingCount({ left_to_categorize: 212 }, pageRows, new Set())).toBe(212);
    expect(remainingCount(undefined, pageRows, new Set())).toBe(0);
  });

  test('position is rows done plus one, the total is done plus what is left', () => {
    expect(progressView(36, 176)).toEqual({ position: 37, total: 212, fraction: 36 / 212 });
    expect(progressView(0, 5)).toEqual({ position: 1, total: 5, fraction: 0 });
  });

  test('the last row does not count past the total, and an empty run is zero', () => {
    expect(progressView(5, 0)).toEqual({ position: 5, total: 5, fraction: 1 });
    expect(progressView(0, 0)).toEqual({ position: 0, total: 0, fraction: 0 });
  });

  test('the counter reads "37 of 212"', () => {
    expect(progressLabel(progressView(36, 176))).toBe('37 of 212');
  });
});

describe('queueRowSubline', () => {
  test('date and best category', () => {
    expect(queueRowSubline(row('a', [0.9]), '21/11')).toBe('21/11 · Fuel');
  });

  test('a manual row says why it has no chips', () => {
    expect(queueRowSubline(row('a', [], 'no_suggestion'), '21/11')).toBe('21/11 · no suggestion');
  });
});
