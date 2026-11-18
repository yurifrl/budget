import { describe, expect, test } from 'bun:test';

import { deleteNeedsConfirm, isBatchTarget, menuTargetIds, toggleChecked } from './planSelection';
import { cat, month } from './__fixtures__/plan.fixtures';

describe('toggleChecked', () => {
  test('adds an unchecked row at the end, removes a checked one', () => {
    expect([...toggleChecked(new Set(['a']), 'b')]).toEqual(['a', 'b']);
    expect([...toggleChecked(new Set(['a', 'b']), 'a')]).toEqual(['b']);
  });

  test('returns a new set and leaves the input alone', () => {
    const prev = new Set(['a']);
    const next = toggleChecked(prev, 'a');
    expect(next).not.toBe(prev);
    expect([...prev]).toEqual(['a']);
    expect(next.size).toBe(0);
  });
});

describe('isBatchTarget / menuTargetIds', () => {
  test('two or more checked and the row among them: the whole selection, in check order', () => {
    const checked = new Set(['b', 'a', 'c']);
    expect(isBatchTarget(checked, 'a')).toBe(true);
    expect(menuTargetIds(checked, 'a')).toEqual(['b', 'a', 'c']);
  });

  test('a row outside the selection acts alone', () => {
    const checked = new Set(['a', 'b']);
    expect(isBatchTarget(checked, 'z')).toBe(false);
    expect(menuTargetIds(checked, 'z')).toEqual(['z']);
  });

  test('a single checked row is not a batch, nor is an empty selection', () => {
    expect(isBatchTarget(new Set(['a']), 'a')).toBe(false);
    expect(menuTargetIds(new Set(['a']), 'a')).toEqual(['a']);
    expect(menuTargetIds(new Set(), 'a')).toEqual(['a']);
  });
});

describe('deleteNeedsConfirm', () => {
  const categories = [cat('a'), cat('b')];
  const bm = month({ a: { activity: 0 }, b: { activity: -1 }, ghost: { activity: -500 } });

  test('asks when any target has activity this month (either sign)', () => {
    expect(deleteNeedsConfirm(['a'], categories, bm)).toBe(false);
    expect(deleteNeedsConfirm(['a', 'b'], categories, bm)).toBe(true);
    expect(deleteNeedsConfirm(['b'], categories, month({ b: { activity: 20 } }))).toBe(true);
  });

  test('ids that are not categories never ask; no ids never ask', () => {
    expect(deleteNeedsConfirm(['ghost'], categories, bm)).toBe(false);
    expect(deleteNeedsConfirm([], categories, bm)).toBe(false);
  });
});
