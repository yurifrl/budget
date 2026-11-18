import { describe, expect, test } from 'bun:test';

import { computeDropTarget, dropLabel, type RowRect } from './planDrop';

// Three 40px rows with a 10px gap between b and c.
const rects = new Map<string, RowRect>([
  ['a', { top: 100, bottom: 140 }],
  ['b', { top: 140, bottom: 180 }],
  ['c', { top: 190, bottom: 230 }],
]);
const order = ['a', 'b', 'c'];

describe('computeDropTarget', () => {
  test('over a row: top quarter = before, middle half = bundle, bottom quarter = after', () => {
    expect(computeDropTarget(105, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'before' });
    expect(computeDropTarget(120, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'bundle' });
    expect(computeDropTarget(135, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'after' });
  });

  test('quarter boundaries belong to the middle (bundle) zone', () => {
    expect(computeDropTarget(110, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'bundle' });
    expect(computeDropTarget(130, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'bundle' });
  });

  test('a shared edge goes to the first row in display order', () => {
    expect(computeDropTarget(140, 'c', order, rects)).toEqual({ rowId: 'a', intent: 'after' });
  });

  test('the dragged row is never the target: over itself falls to the nearest other edge', () => {
    expect(computeDropTarget(150, 'b', order, rects)).toEqual({ rowId: 'a', intent: 'after' });
    expect(computeDropTarget(175, 'b', order, rects)).toEqual({ rowId: 'c', intent: 'before' });
  });

  test('in a gap: nearest edge; a tie keeps the earlier row', () => {
    expect(computeDropTarget(183, 'a', order, rects)).toEqual({ rowId: 'b', intent: 'after' });
    expect(computeDropTarget(188, 'a', order, rects)).toEqual({ rowId: 'c', intent: 'before' });
    expect(computeDropTarget(185, 'a', order, rects)).toEqual({ rowId: 'b', intent: 'after' });
  });

  test('past the ends: before the first / after the last', () => {
    expect(computeDropTarget(0, 'b', order, rects)).toEqual({ rowId: 'a', intent: 'before' });
    expect(computeDropTarget(999, 'b', order, rects)).toEqual({ rowId: 'c', intent: 'after' });
  });

  test('rows without a measured rect are skipped; nothing measured = no target', () => {
    expect(computeDropTarget(120, 'c', ['zz', 'a'], rects)).toEqual({ rowId: 'a', intent: 'bundle' });
    expect(computeDropTarget(120, 'c', order, new Map())).toBeNull();
    expect(computeDropTarget(120, 'a', ['a'], rects)).toBeNull();
    expect(computeDropTarget(120, 'a', [], rects)).toBeNull();
  });

  test('rows not in the display order are ignored even when measured', () => {
    expect(computeDropTarget(120, 'c', ['b'], rects)).toEqual({ rowId: 'b', intent: 'before' });
  });

  test('a zero-height row under the pointer bundles', () => {
    const flat = new Map<string, RowRect>([['a', { top: 50, bottom: 50 }]]);
    expect(computeDropTarget(50, 'x', ['a'], flat)).toEqual({ rowId: 'a', intent: 'bundle' });
  });
});

describe('dropLabel', () => {
  const categories = [
    { id: 'doc', name: 'Doctor' },
    { id: 'pill', name: 'Pills', bundleId: 'med' },
    { id: 'orphan', name: 'Orphan', bundleId: 'gone' },
  ];
  const bundles = [{ id: 'med', groupId: 'g1', name: 'Medicines' }];

  test('onto a bundle row or a bundled category: "Add to <bundle>"', () => {
    expect(dropLabel({ rowId: 'bundle:med' }, categories, bundles)).toBe('Add to Medicines');
    expect(dropLabel({ rowId: 'pill' }, categories, bundles)).toBe('Add to Medicines');
  });

  test('onto a plain category, or one whose bundle no longer exists: "Bundle with <name>"', () => {
    expect(dropLabel({ rowId: 'doc' }, categories, bundles)).toBe('Bundle with Doctor');
    expect(dropLabel({ rowId: 'orphan' }, categories, bundles)).toBe('Bundle with Orphan');
  });

  test('unknown rows fall back to an empty name', () => {
    expect(dropLabel({ rowId: 'nope' }, categories, bundles)).toBe('Bundle with ');
    expect(dropLabel({ rowId: 'bundle:gone' }, categories, bundles)).toBe('Bundle with ');
  });
});
