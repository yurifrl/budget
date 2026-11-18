/**
 * Calculator keypad of the add-transaction sheet: digits build an amount in
 * cents (the last two digits are the cents), an operator parks the running
 * value in `pending` and starts a new operand, and the settled amount is what
 * the sheet shows and saves. Arithmetic is quickmath's integer-cents step.
 */

import { applyMathOp, type MathOp } from './quickmath';
import type { Cents } from './types';

export interface KeypadState {
  /** The operand being typed (0 right after an operator). */
  amount: Cents;
  /** Running value and the operator waiting for the next operand. */
  pending: { value: Cents; op: MathOp } | null;
}

/** Typed amounts stop growing here (9.999.999,99). */
export const KEYPAD_MAX: Cents = 999999999;

/** Keys in grid order (4 per row); `done` saves. */
export const KEYPAD_KEYS = ['7', '8', '9', '÷', '4', '5', '6', '×', '1', '2', '3', '−', '0', '⌫', '+', 'done'] as const;
export type KeypadKey = (typeof KEYPAD_KEYS)[number];

/** Operator and backspace keys (drawn in the accent colour). */
export function isKeypadOpKey(key: string): boolean {
  return '÷×−+⌫'.includes(key);
}

const isMathOp = (key: string): key is MathOp => key === '+' || key === '−' || key === '×' || key === '÷';

export function keypadStart(amount: Cents = 0): KeypadState {
  return { amount, pending: null };
}

export function pressDigit(s: KeypadState, digit: number): KeypadState {
  return { ...s, amount: Math.min(s.amount * 10 + digit, KEYPAD_MAX) };
}

export function pressBackspace(s: KeypadState): KeypadState {
  return { ...s, amount: Math.floor(s.amount / 10) };
}

/**
 * An operator folds the typed operand into the running value (a failed step,
 * e.g. ÷0 or overflow, keeps the running value) and waits for the next one.
 */
export function pressOp(s: KeypadState, op: MathOp): KeypadState {
  return {
    pending: { value: s.pending ? (applyMathOp(s.pending.value, op, s.amount) ?? s.pending.value) : s.amount, op },
    amount: 0,
  };
}

/** Chained ops accumulate in `pending`; the typed amount is 0 between ops. */
export function settledAmount(s: KeypadState): Cents {
  if (!s.pending) return s.amount;
  if (s.amount === 0) return s.pending.value;
  return applyMathOp(s.pending.value, s.pending.op, s.amount) ?? s.pending.value;
}

export type KeypadAction = { type: 'key'; key: Exclude<KeypadKey, 'done'> } | { type: 'reset' };

export function keypadReducer(s: KeypadState, action: KeypadAction): KeypadState {
  if (action.type === 'reset') return keypadStart();
  const { key } = action;
  if (key === '⌫') return pressBackspace(s);
  if (isMathOp(key)) return pressOp(s, key);
  return pressDigit(s, Number(key));
}
