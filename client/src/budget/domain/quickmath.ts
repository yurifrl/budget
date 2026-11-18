/**
 * Quick-math evaluation for Assigned cells (syscd-app-5xt): the draft may be
 * an arithmetic expression over + − × ÷, evaluated strictly left-to-right on
 * integer cents so money never drifts through floats. A leading +/− hugging
 * digits is that number's SIGN, never an operator — a lone signed number
 * sets the cell ("-1.617,00" is the value −R$ 1.617,00; this is also the
 * untouched pre-filled draft, so an unedited negative value re-commits
 * unchanged). With two operands the draft is an equation
 * ("-1.617,00-500" → (−1.617) − 500). A leading ×/÷ cannot sign a number,
 * so it applies to the cell's current value ("×2" doubles, "÷2" halves).
 * Returns null for empty/invalid input — callers keep the prior value.
 */

import type { Cents } from './types';
import { formatMoney, parseMoney } from './format';

/** On-screen glyphs plus the keyboard aliases users actually type. */
const OPS: Record<string, MathOp> = {
  '+': '+',
  '−': '−',
  '-': '−',
  '×': '×',
  '*': '×',
  '÷': '÷',
  '/': '÷',
};

/** The four on-screen arithmetic glyphs. */
export type MathOp = '+' | '−' | '×' | '÷';

/** One arithmetic step on integer cents — shared by quick-math expressions and
 * the add-transaction keypad's pending-operator math. Returns null on overflow
 * or ÷0; callers keep the prior value. */
export function applyMathOp(acc: Cents, op: MathOp, operand: Cents): Cents | null {
  switch (op) {
    case '+':
      return acc + operand;
    case '−':
      return acc - operand;
    case '×': {
      // Cents × cents / 100 keeps integer math; fractional cents round to
      // the nearest cent; bail out beyond safe range.
      const product = acc * operand;
      if (!Number.isSafeInteger(product)) return null;
      return Math.round(product / 100);
    }
    case '÷': {
      if (operand === 0) return null;
      const scaled = acc * 100;
      if (!Number.isSafeInteger(scaled)) return null;
      return Math.round(scaled / operand);
    }
  }
}

export function evalQuickMath(expr: string, currentCents: Cents): Cents | null {
  const s = expr.trim();
  if (!s) return null;

  // A leading +/− hugging digits is the first number's SIGN, not a relative
  // operator: the untouched pre-filled draft of a negative cell ("-1.617,00")
  // must re-commit as the value itself, and "-1.617,00-500" is the equation
  // (−1.617) − 500. Only ×/÷ lead relative math — they cannot sign a number.
  const signed = /^[+−-][0-9]/.test(s);
  const sign = signed && s[0] !== '+' ? -1 : 1;
  const body = signed ? s.slice(1) : s;

  let acc: Cents | null = null;
  let pendingOp: MathOp | null = null;
  let num = '';
  let numClosed = false;

  /** Flush the collected number: the first operand carries the sign, later
   * ones resolve the pending equation. False on overflow or ÷0. */
  const flush = (): boolean => {
    let value = parseMoney(num);
    num = '';
    numClosed = false;
    if (acc === null) {
      if (sign < 0) value = -value;
      acc = value;
      return true;
    }
    const applied = applyMathOp(acc, pendingOp!, value);
    if (applied === null) return false;
    acc = applied;
    return true;
  };

  for (const ch of body) {
    const op = OPS[ch];
    if (op) {
      if (num) {
        if (!flush()) return null;
      } else if (acc === null) {
        acc = currentCents; // leading operator applies to the current value
      } else {
        return null; // consecutive operators
      }
      pendingOp = op;
    } else if (/[0-9.,\u00a0]/.test(ch)) {
      if (numClosed) return null; // numbers split by spaces need an operator
      num += ch;
    } else if (ch === ' ' || ch === '\t') {
      if (num) numClosed = true;
    } else {
      return null; // unknown character
    }
  }

  if (num) {
    if (!flush()) return null;
  } else if (pendingOp !== null) {
    return null; // dangling operator
  }
  if (acc === null || !Number.isSafeInteger(acc)) return null;
  return acc;
}

// ---------------------------------------------------------------------------
// Numpad state machine (syscd-app-m1hr) — the MobileAssignNumpad keypad as a
// pure engine on the same integer-cents rules: digits enter cents-first,
// '=' commits/replaces, '+'/'−' stack an equation. 'done' (✓) stays a UI-only
// commit and never reaches the engine.
// ---------------------------------------------------------------------------

/** The keypad glyphs MobileAssignNumpad actually renders (KEY_ROWS: 789−
 * 456+ 123= ✕0⌫), minus the UI-only keys: 'close' (✕) dismisses the panel
 * and 'done' (✓) commits. */
export type NumpadDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type NumpadOp = '=' | '+' | '−';
export type NumpadKey = NumpadDigit | NumpadOp | 'del';

/** One numpad moment: the committed left side, the pending operator, and the
 * digits typed so far. op '=' means the operand replaces base when committed;
 * '+'/'−' mean the stacked equation `base op operand` keeps the old number on
 * top and resolves on the next operator or '='. */
export type NumpadState = {
  base: Cents | null;
  op: NumpadOp;
  operand: string;
};

/** Fresh numpad state: nothing typed; resolve() is null so callers fall back
 * to the row's current value. Frozen — states are immutable, transitions
 * return new objects. */
export const EMPTY_NUMPAD_STATE: NumpadState = Object.freeze({
  base: null,
  op: '=',
  operand: '',
});

/** The typed digit string as integer cents — digits ARE cents (cents-first
 * entry, '063' is R$0,63). Null when empty or beyond the safe integer range. */
function operandCents(operand: string): Cents | null {
  if (!operand) return null;
  const cents = Number(operand);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Value the pad shows for `state`: the typed operand under '=', the stacked
 * equation resolved on integer cents, or just the base. Null when nothing is
 * entered or the result overflows the safe integer range — callers keep the
 * prior value, mirroring evalQuickMath. */
export function resolve(state: NumpadState): Cents | null {
  const operand = operandCents(state.operand);
  const value =
    state.op === '='
      ? (operand ?? state.base)
      : operand === null || state.base === null
        ? state.base
        : applyMathOp(state.base, state.op, operand);
  return value !== null && Number.isSafeInteger(value) ? value : null;
}

/** Apply one keypad press, returning the next state. The input is never
 * mutated; a rejected press — a digit or '=' that would overflow, or an
 * operator with nothing to apply to — returns the prior state unchanged.
 * Mirrors the press() switch in MobileAssignNumpad. */
export function applyNumpadKey(state: NumpadState, key: NumpadKey): NumpadState {
  switch (key) {
    case '0':
    case '1':
    case '2':
    case '3':
    case '4':
    case '5':
    case '6':
    case '7':
    case '8':
    case '9': {
      const operand = state.operand + key;
      if (!Number.isSafeInteger(Number(operand))) return state; // reject overflow
      return { ...state, operand };
    }
    case '=':
    case '+':
    case '−': {
      // Commit what's on screen: '=' replaces the base, '+'/'−' resolve the
      // pending equation and open the next operand under the pressed op.
      const committed = resolve(state);
      if (committed === null) return state;
      return { base: committed, op: key, operand: '' };
    }
    case 'del': {
      if (state.operand) return { ...state, operand: state.operand.slice(0, -1) };
      // Popping an empty operand reverts to the base with op '='.
      if (state.op !== '=') return { base: state.base, op: '=', operand: '' };
      return state;
    }
  }
}

/** Display text for the typed operand — punctuation automatic through the
 * shared pt-BR money formatter: '1' → R$0,01, '11' → R$0,11, '111' → R$1,11. */
export function numpadOperandText(operand: string): string {
  return formatMoney(operandCents(operand) ?? 0);
}
