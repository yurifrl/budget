import { describe, expect, test } from 'bun:test';

import { categorizeKeyAction } from './keys.logic';

const base = { suggestions: 2, typing: false, undoAvailable: false };

describe('categorizeKeyAction', () => {
  test('1/2/3 file with that chip only when the chip exists', () => {
    expect(categorizeKeyAction('1', base)).toEqual({ kind: 'file', index: 0 });
    expect(categorizeKeyAction('2', base)).toEqual({ kind: 'file', index: 1 });
    expect(categorizeKeyAction('3', base)).toBeNull();
    expect(categorizeKeyAction('1', { ...base, suggestions: 0 })).toBeNull();
  });

  test('Enter files the top chip, and does nothing without one', () => {
    expect(categorizeKeyAction('Enter', base)).toEqual({ kind: 'fileTop' });
    expect(categorizeKeyAction('Enter', { ...base, suggestions: 0 })).toBeNull();
  });

  test('S skips, / focuses the search, Z undoes when something is undoable', () => {
    expect(categorizeKeyAction('s', base)).toEqual({ kind: 'skip' });
    expect(categorizeKeyAction('S', base)).toEqual({ kind: 'skip' });
    expect(categorizeKeyAction('/', base)).toEqual({ kind: 'focusSearch' });
    expect(categorizeKeyAction('z', base)).toBeNull();
    expect(categorizeKeyAction('Z', { ...base, undoAvailable: true })).toEqual({ kind: 'undo' });
  });

  test('typing in a field claims every key', () => {
    const typing = { ...base, typing: true, undoAvailable: true };
    for (const key of ['1', '2', '3', 'Enter', 's', 'S', '/', 'z', 'Z']) {
      expect(categorizeKeyAction(key, typing)).toBeNull();
    }
  });

  test('unmapped keys do nothing', () => {
    expect(categorizeKeyAction('q', base)).toBeNull();
    expect(categorizeKeyAction('Escape', base)).toBeNull();
  });
});
