import { describe, expect, test } from 'bun:test';

import { categorizeKeyAction, controlToBlur, hasModifier, isControlTarget, isTypingTarget, mayKeyAct } from './keys.logic';

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

  test('no other key is a shortcut: letters do nothing, so typing a name never skips or files', () => {
    for (const key of ['u', 'b', 'q', 'M', 'ú', 'Escape', 'Tab', ' ']) {
      expect(categorizeKeyAction(key, base)).toBeNull();
    }
  });

  test('S, Z and the digits never act while a field is focused, typing is left to the field', () => {
    const typing = { ...base, typing: true, undoAvailable: true };
    for (const key of ['s', 'S', 'z', 'Z', '1', '2', '3', 'm', 'Enter', '/']) {
      expect(categorizeKeyAction(key, typing)).toBeNull();
    }
  });

  test('Escape leaves the field and returns to the shortcuts', () => {
    expect(categorizeKeyAction('Escape', { ...base, typing: true })).toEqual({ kind: 'leaveField' });
    expect(categorizeKeyAction('Escape', base)).toBeNull();
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

describe('mayKeyAct', () => {
  const none = { onBody: false, inPage: false, overlayOpen: false };

  test('acts on the bare document and inside the page', () => {
    expect(mayKeyAct({ ...none, onBody: true })).toBe(true);
    expect(mayKeyAct({ ...none, inPage: true })).toBe(true);
  });

  test('never acts while an overlay is open, wherever focus is', () => {
    expect(mayKeyAct({ onBody: true, inPage: false, overlayOpen: true })).toBe(false);
    expect(mayKeyAct({ onBody: false, inPage: true, overlayOpen: true })).toBe(false);
  });

  test('a key pressed in the shell (rail, menu panes) outside the page does not act', () => {
    expect(mayKeyAct(none)).toBe(false);
  });
});

describe('undo-only scope (Bundles view)', () => {
  const ctx = { suggestions: 0, typing: false, undoAvailable: true, scope: 'undoOnly' as const };

  test('Z undoes; the row shortcuts do nothing there', () => {
    expect(categorizeKeyAction('z', ctx)).toEqual({ kind: 'undo' });
    for (const key of ['s', 'S', '1', '2', '3', 'Enter', '/']) expect(categorizeKeyAction(key, ctx)).toBeNull();
  });

  test('without anything to undo nothing acts; a field still owns its keys', () => {
    expect(categorizeKeyAction('z', { ...ctx, undoAvailable: false })).toBeNull();
    expect(categorizeKeyAction('z', { ...ctx, typing: true })).toBeNull();
  });
});
