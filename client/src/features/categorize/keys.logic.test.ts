import { describe, expect, test } from 'bun:test';

import { categorizeKeyAction, controlToBlur, hasModifier, isControlTarget, isPrintable, isTypingTarget } from './keys.logic';

const base = { suggestions: 2, typing: false, undoAvailable: false };

describe('categorizeKeyAction', () => {
  test('1/2/3 file with that chip only when the chip exists', () => {
    expect(categorizeKeyAction('1', base)).toEqual({ kind: 'file', index: 0 });
    expect(categorizeKeyAction('2', base)).toEqual({ kind: 'file', index: 1 });
    expect(categorizeKeyAction('3', base)).toEqual({ kind: 'typeToSearch' });
    expect(categorizeKeyAction('1', { ...base, suggestions: 0 })).toEqual({ kind: 'typeToSearch' });
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

  test('any other printable key starts typing in the search, named keys do nothing', () => {
    expect(categorizeKeyAction('q', base)).toEqual({ kind: 'typeToSearch' });
    expect(categorizeKeyAction('M', base)).toEqual({ kind: 'typeToSearch' });
    expect(categorizeKeyAction('ú', base)).toEqual({ kind: 'typeToSearch' });
    expect(categorizeKeyAction('Escape', base)).toBeNull();
    expect(categorizeKeyAction('Tab', base)).toBeNull();
    expect(categorizeKeyAction(' ', base)).toBeNull();
  });

  test('printable keys are single visible characters', () => {
    expect(isPrintable('a')).toBe(true);
    expect(isPrintable('Enter')).toBe(false);
    expect(isPrintable(' ')).toBe(false);
  });

  test('S, Z and the digits never act while a field is focused, typing is left to the field', () => {
    const typing = { ...base, typing: true, undoAvailable: true };
    for (const key of ['s', 'z', '1', '2', '3', 'm']) expect(categorizeKeyAction(key, typing)).toBeNull();
  });
});

describe('key targets', () => {
  test('inputs, textareas, selects and contenteditable are typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'textarea' })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  test('buttons and role=button elements are controls', () => {
    expect(isControlTarget({ tagName: 'BUTTON' })).toBe(true);
    expect(isControlTarget({ tagName: 'DIV', getAttribute: (n) => (n === 'role' ? 'button' : null) })).toBe(true);
    expect(isControlTarget({ tagName: 'DIV', getAttribute: () => null })).toBe(false);
  });

  test('Enter on a focused control is left to the control', () => {
    expect(categorizeKeyAction('Enter', { ...base, onControl: true })).toBeNull();
    expect(categorizeKeyAction('1', { ...base, onControl: true })).toEqual({ kind: 'file', index: 0 });
  });

  test('modifiers disable shortcuts', () => {
    expect(hasModifier({ metaKey: true })).toBe(true);
    expect(hasModifier({ ctrlKey: true })).toBe(true);
    expect(hasModifier({})).toBe(false);
  });
});

describe('controlToBlur', () => {
  const button = { id: 'button' };
  const target = { closest: (selector: string) => (selector.includes('role="button"') ? button : null) };

  test('a pointer click on a button lets go of its focus', () => {
    expect(controlToBlur(target, 1)).toBe(button);
  });

  test('a keyboard activation keeps focus for Tab navigation', () => {
    expect(controlToBlur(target, 0)).toBeNull();
  });

  test('a click outside any control, or on nothing, blurs nothing', () => {
    expect(controlToBlur({ closest: () => null }, 1)).toBeNull();
    expect(controlToBlur(null, 1)).toBeNull();
    expect(controlToBlur({}, 1)).toBeNull();
  });
});
