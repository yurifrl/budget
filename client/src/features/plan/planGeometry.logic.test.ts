import { describe, expect, test } from 'bun:test';

import { assignDropdownAnchor, numpadAlignOffset, pillPopPosition, recentCardPosition } from './planGeometry.logic';

describe('assignDropdownAnchor', () => {
  test('6px under the button, right edges aligned', () => {
    expect(assignDropdownAnchor({ x: 800, y: 20, width: 90, height: 30 }, 1000)).toEqual({ top: 56, right: 110 });
  });

  test('keeps a 12px right margin when the button touches or passes the edge', () => {
    expect(assignDropdownAnchor({ x: 905, y: 0, width: 90, height: 30 }, 1000)).toEqual({ top: 36, right: 12 });
    expect(assignDropdownAnchor({ x: 950, y: 0, width: 90, height: 30 }, 1000).right).toBe(12);
  });
});

describe('recentCardPosition', () => {
  test('at the press point, 6px lower', () => {
    expect(recentCardPosition({ x: 200, y: 40 }, 1200)).toEqual({ left: 200, top: 46 });
  });

  test('clamped 330px from the right edge, then 12px from the left (left wins on a narrow window)', () => {
    expect(recentCardPosition({ x: 1100, y: 40 }, 1200).left).toBe(870);
    expect(recentCardPosition({ x: 3, y: 40 }, 1200).left).toBe(12);
    expect(recentCardPosition({ x: 200, y: 40 }, 320).left).toBe(12);
  });
});

describe('pillPopPosition', () => {
  test('24px left of the anchor and 14px under it', () => {
    expect(pillPopPosition({ x: 500, y: 300 }, { width: 1200, height: 900 })).toEqual({ left: 476, top: 314 });
  });

  test('clamped into the window on every side', () => {
    expect(pillPopPosition({ x: 1190, y: 300 }, { width: 1200, height: 900 }).left).toBe(888);
    expect(pillPopPosition({ x: 20, y: 300 }, { width: 1200, height: 900 }).left).toBe(12);
    expect(pillPopPosition({ x: 500, y: 800 }, { width: 1200, height: 900 }).top).toBe(570);
    expect(pillPopPosition({ x: 500, y: 800 }, { width: 1200, height: 300 }).top).toBe(12);
    expect(pillPopPosition({ x: 500, y: -40 }, { width: 1200, height: 300 }).top).toBe(-26);
  });
});

describe('numpadAlignOffset', () => {
  test('scrolls by the distance between the row and its slot above the panel', () => {
    // Slot top = 600 - 8 - 40 = 552; the row is 100px below it.
    expect(numpadAlignOffset({ y: 652, height: 40 }, 600, 300)).toBe(400);
    expect(numpadAlignOffset({ y: 452, height: 40 }, 600, 300)).toBe(200);
  });

  test('never scrolls above the top of the list', () => {
    expect(numpadAlignOffset({ y: 100, height: 40 }, 600, 50)).toBe(0);
  });

  test('null when the panel is not laid out or the row is already in place (under 1px)', () => {
    expect(numpadAlignOffset({ y: 652, height: 40 }, 0, 300)).toBeNull();
    expect(numpadAlignOffset({ y: 552, height: 40 }, 600, 300)).toBeNull();
    expect(numpadAlignOffset({ y: 552.9, height: 40 }, 600, 300)).toBeNull();
    expect(numpadAlignOffset({ y: 553, height: 40 }, 600, 300)).toBe(301);
  });
});
