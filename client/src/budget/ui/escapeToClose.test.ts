import { describe, expect, test } from 'bun:test';

import { onEscapeKey } from './escapeToClose';

describe('onEscapeKey', () => {
  const run = (key: string, claimedByInner: boolean) => {
    let closed = false;
    const e = { key, defaultPrevented: false };
    let deferred: (() => void) | null = null;
    onEscapeKey(e, () => (closed = true), (fn) => (deferred = fn));
    if (claimedByInner) e.defaultPrevented = true; // an inner handler ran after the capture listener
    (deferred as (() => void) | null)?.();
    return closed;
  };

  test('Escape nobody claimed closes', () => expect(run('Escape', false)).toBe(true));
  test('Escape an inner select/editor claimed does not close', () => expect(run('Escape', true)).toBe(false));
  test('other keys do nothing', () => expect(run('Enter', false)).toBe(false));
});
