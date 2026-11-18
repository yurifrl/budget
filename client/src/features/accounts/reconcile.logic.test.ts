import { describe, expect, test } from 'bun:test';

import { desktopReconcileAnchor, linkedToastText, phoneReconcileAnchor, reconcileDifference } from './reconcile.logic';

describe('desktopReconcileAnchor', () => {
  test('under the button, right edge inset 16, in screen-root space', () => {
    expect(desktopReconcileAnchor({ x: 500, y: 120, w: 100, h: 30 }, { x: 200, y: 20, w: 900 })).toEqual({ x: 384, y: 136 });
  });
  test('x clamps so the 268px popover stays on screen', () => {
    expect(desktopReconcileAnchor({ x: 1000, y: 0, w: 100, h: 30 }, { x: 200, y: 0, w: 900 })).toEqual({ x: 632, y: 36 });
    expect(desktopReconcileAnchor({ x: 0, y: 0, w: 10, h: 30 }, { x: 200, y: 0, w: 900 }).x).toBe(0);
  });
  test('an unmeasured screen width (0) leaves x unclamped', () => {
    expect(desktopReconcileAnchor({ x: 0, y: 0, w: 10, h: 30 }, { x: 200, y: 0, w: 0 }).x).toBe(-206);
  });
});

describe('phoneReconcileAnchor', () => {
  test('right-aligned under the header row', () => {
    expect(phoneReconcileAnchor({ y: 100, h: 40 }, { y: 60, w: 390 })).toEqual({ x: 122, y: 86 });
  });
  test('a screen narrower than the popover pins to 0; unmeasured width is 0', () => {
    expect(phoneReconcileAnchor({ y: 100, h: 40 }, { y: 60, w: 200 }).x).toBe(0);
    expect(phoneReconcileAnchor({ y: 100, h: 40 }, { y: 60, w: 0 }).x).toBe(0);
  });
  test('an unmeasured header (height 0) falls back to y = 96', () => {
    expect(phoneReconcileAnchor({ y: 100, h: 0 }, { y: 60, w: 390 }).y).toBe(96);
  });
});

describe('reconcileDifference', () => {
  const account = { clearedBalance: 1000, unclearedBalance: 250 };
  test('stated minus the WORKING balance while a session is open', () => {
    expect(reconcileDifference(true, account, 1500)).toBe(250);
    expect(reconcileDifference(true, account, 1250)).toBe(0);
  });
  test('0 outside a session or without an account', () => {
    expect(reconcileDifference(false, account, 1500)).toBe(0);
    expect(reconcileDifference(true, undefined, 1500)).toBe(0);
  });
});

describe('linkedToastText', () => {
  test('pluralises', () => {
    expect(linkedToastText(1)).toBe('Linked 1 account');
    expect(linkedToastText(3)).toBe('Linked 3 accounts');
  });
});
