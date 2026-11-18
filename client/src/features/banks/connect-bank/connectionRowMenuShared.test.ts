import { describe, expect, test } from 'bun:test';

import { connectionRowActions, removeConfirmation } from './connectionRowMenuShared';

describe('connectionRowActions', () => {
  test('connected: sync, reimport, settings, remove (destructive, always tappable)', () => {
    const a = connectionRowActions({ status: 'connected' });
    expect(a.map((x) => x.kind)).toEqual(['sync', 'reimport', 'settings', 'disconnect']);
    expect(a.at(-1)).toMatchObject({ danger: true })
    expect(a.at(-1)?.disabled).toBeUndefined();
    expect(a.find((x) => x.kind === 'settings')?.disabled).toBeUndefined();
  });
  test('unauthorized: reconnect appears and sync/reimport are disabled', () => {
    const a = connectionRowActions({ status: 'unauthorized' });
    expect(a.map((x) => x.kind)).toEqual(['sync', 'reconnect', 'reimport', 'settings', 'disconnect']);
    expect(a[0]?.disabled).toBe(true);
  });
});

describe('removeConfirmation', () => {
  test('blocked when linked, pluralised', () => {
    expect(removeConfirmation('Chase', 1).message).toContain('1 linked account in');
    expect(removeConfirmation('Chase', 3)).toMatchObject({ kind: 'blocked' });
    expect(removeConfirmation('Chase', 3).message).toContain('3 linked accounts');
  });
  test('confirm otherwise', () => {
    const c = removeConfirmation('Chase', 0);
    expect(c.kind).toBe('confirm');
    expect(c.title).toBe('Remove Chase?');
  });
});
