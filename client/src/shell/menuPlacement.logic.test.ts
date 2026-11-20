import { describe, expect, test } from 'bun:test';

import { menuPlacement, MIN_MENU_BODY } from './menuPlacement.logic';

const base = { menuWidth: 312, chromeHeight: 50, bodyCap: 640 };

describe('menuPlacement', () => {
  test('desktop: sits above the trigger, left-aligned with it', () => {
    const p = menuPlacement({ ...base, trigger: { x: 11, y: 840 }, win: { width: 1440, height: 900 } });
    expect(p).toEqual({ left: 11, bottom: 66, width: 312, maxBody: 640 });
  });

  test('the body shrinks to the room above the trigger', () => {
    const p = menuPlacement({ ...base, trigger: { x: 11, y: 540 }, win: { width: 1280, height: 600 } });
    expect(p.bottom).toBe(66);
    // 600 - 66 (bottom) - 8 (margin) - 50 (chrome)
    expect(p.maxBody).toBe(476);
    expect(p.bottom + p.maxBody + 50).toBeLessThanOrEqual(600 - 8);
  });

  test('the top inset (status bar) is kept clear', () => {
    const p = menuPlacement({ ...base, trigger: { x: 11, y: 780 }, win: { width: 390, height: 844 }, topInset: 47 });
    expect(p.bottom).toBe(70);
    expect(p.maxBody).toBe(640);
    const top = 844 - p.bottom - p.maxBody - 50;
    expect(top).toBeGreaterThanOrEqual(47 + 8);
  });

  test('a short window covers the trigger instead of leaving a sliver', () => {
    const p = menuPlacement({ ...base, trigger: { x: 11, y: 260 }, win: { width: 568, height: 320 } });
    // above the trigger: 320 - 66 - 8 - 50 = 196 < MIN_MENU_BODY
    expect(196).toBeLessThan(MIN_MENU_BODY);
    expect(p.bottom).toBe(8);
    expect(p.maxBody).toBe(254);
  });

  test('the body never collapses below its floor', () => {
    const p = menuPlacement({ ...base, trigger: { x: 0, y: 100 }, win: { width: 300, height: 120 } });
    expect(p.bottom).toBe(8);
    expect(p.maxBody).toBe(96);
  });

  test('a narrow window shrinks the menu and keeps both side margins', () => {
    const p = menuPlacement({ ...base, trigger: { x: 11, y: 500 }, win: { width: 300, height: 568 } });
    expect(p.width).toBe(284);
    expect(p.left).toBe(8);
  });

  test('a trigger near the right edge is pulled back on screen', () => {
    const p = menuPlacement({ ...base, trigger: { x: 900, y: 700 }, win: { width: 1000, height: 768 } });
    expect(p.left).toBe(1000 - 312 - 8);
  });

  test('the collapsed rail (trigger at x=20) keeps the menu at the left margin or beyond', () => {
    const p = menuPlacement({ ...base, trigger: { x: 2, y: 850 }, win: { width: 1440, height: 900 } });
    expect(p.left).toBe(8);
  });

  test('an unmeasured trigger falls back to the bottom edge', () => {
    const p = menuPlacement({ ...base, trigger: { x: 0, y: 0 }, win: { width: 390, height: 844 } });
    expect(p.bottom).toBe(8);
  });

  test('the keyboard lifts the menu and shrinks the body', () => {
    const p = menuPlacement({
      ...base,
      trigger: { x: 11, y: 780 },
      win: { width: 390, height: 844 },
      topInset: 47,
      keyboardHeight: 336,
    });
    expect(p.bottom).toBe(344);
    // 844 - 344 - 8 - 47 - 50
    expect(p.maxBody).toBe(395);
  });
});
