import { describe, expect, test } from 'bun:test';

import {
  isKeypadOpKey,
  KEYPAD_KEYS,
  KEYPAD_MAX,
  keypadReducer,
  keypadStart,
  pressBackspace,
  pressDigit,
  pressOp,
  settledAmount,
  type KeypadKey,
  type KeypadState,
} from './txnKeypad';

const type = (keys: Exclude<KeypadKey, 'done'>[], from: KeypadState = keypadStart()) =>
  keys.reduce((s, key) => keypadReducer(s, { type: 'key', key }), from);

describe('keypad layout', () => {
  test('16 keys in grid order, done last', () => {
    expect([...KEYPAD_KEYS]).toEqual(['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '⌫', '+', 'done']);
  });

  test('operators and backspace are op keys; digits and done are not', () => {
    expect(KEYPAD_KEYS.filter(isKeypadOpKey)).toEqual(['÷', '×', '−', '⌫', '+']);
  });
});

describe('digits and backspace', () => {
  test('digits shift in from the right, as cents', () => {
    expect(type(['1', '2', '3', '4']).amount).toBe(1234);
    expect(type(['0', '0', '5']).amount).toBe(5);
  });

  test('the amount is capped at KEYPAD_MAX', () => {
    expect(pressDigit({ amount: KEYPAD_MAX, pending: null }, 9).amount).toBe(KEYPAD_MAX);
    expect(pressDigit({ amount: 99999999, pending: null }, 9).amount).toBe(999999999);
    expect(pressDigit({ amount: 100000000, pending: null }, 0).amount).toBe(KEYPAD_MAX);
  });

  test('backspace drops the last digit and stops at zero', () => {
    expect(pressBackspace({ amount: 1234, pending: null }).amount).toBe(123);
    expect(pressBackspace({ amount: 7, pending: null }).amount).toBe(0);
    expect(pressBackspace({ amount: 0, pending: null }).amount).toBe(0);
  });

  test('backspace leaves a pending operator alone', () => {
    const s = type(['5', '0', '0', '+', '2', '5', '⌫']);
    expect(s).toEqual({ amount: 2, pending: { value: 500, op: '+' } });
  });
});

describe('operators', () => {
  test('the first operator parks the typed amount', () => {
    expect(pressOp({ amount: 1500, pending: null }, '+')).toEqual({ amount: 0, pending: { value: 1500, op: '+' } });
  });

  test('a chained operator folds the operand with the NEW operator (current behaviour)', () => {
    // 10,00 + 5,00 then × : the pending '+' is not what gets applied; × is.
    const s = type(['1', '0', '0', '0', '+', '5', '0', '0', '×']);
    expect(s).toEqual({ amount: 0, pending: { value: 5000, op: '×' } });
  });

  test('pressing an operator twice applies it to a zero operand', () => {
    expect(type(['5', '0', '0', '+', '−']).pending).toEqual({ value: 500, op: '−' });
    expect(type(['5', '0', '0', '+', '×']).pending).toEqual({ value: 0, op: '×' });
  });

  test('a failing step (÷ by a zero operand) keeps the running value', () => {
    expect(type(['5', '0', '0', '+', '÷']).pending).toEqual({ value: 500, op: '÷' });
  });
});

describe('settledAmount', () => {
  test('no operator: the typed amount', () => {
    expect(settledAmount(type(['1', '2', '3']))).toBe(123);
    expect(settledAmount(keypadStart())).toBe(0);
  });

  test('right after an operator: the running value', () => {
    expect(settledAmount(type(['1', '2', '3', '+']))).toBe(123);
  });

  test('with an operand: the pending operator applied', () => {
    expect(settledAmount(type(['1', '0', '0', '0', '+', '2', '5', '0']))).toBe(1250);
    expect(settledAmount(type(['1', '0', '0', '0', '−', '2', '5', '0']))).toBe(750);
    // × and ÷ treat the operand as a decimal number: 10,00 × 2,00 = 20,00.
    expect(settledAmount(type(['1', '0', '0', '0', '×', '2', '0', '0']))).toBe(2000);
    expect(settledAmount(type(['1', '0', '0', '0', '÷', '4', '0', '0']))).toBe(250);
  });

  test('subtraction can settle negative (save then refuses it)', () => {
    expect(settledAmount(type(['1', '0', '0', '−', '5', '0', '0']))).toBe(-400);
  });

  test('an overflowing step falls back to the running value', () => {
    const s: KeypadState = { amount: KEYPAD_MAX, pending: { value: Number.MAX_SAFE_INTEGER, op: '×' } };
    expect(settledAmount(s)).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('keypadReducer', () => {
  test('keypadStart seeds an edit with the stored amount', () => {
    expect(keypadStart(4200)).toEqual({ amount: 4200, pending: null });
    expect(type(['5'], keypadStart(4200)).amount).toBe(42005);
  });

  test('reset clears amount and pending', () => {
    expect(keypadReducer(type(['5', '+', '3']), { type: 'reset' })).toEqual({ amount: 0, pending: null });
  });
});
