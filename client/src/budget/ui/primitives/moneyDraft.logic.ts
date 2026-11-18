/**
 * Pure draft-text rules of the money inputs (MoneyInput / AmountCell). The
 * components own focus, refs and the popover; these functions own what the
 * draft string is and what a draft commits to.
 */
import { evalQuickMath } from '../../domain/quickmath';
import type { Cents } from '../../domain/types';

export type QuickMathOp = '+' | '−' | '×' | '÷';

/**
 * Signed pt-BR draft text: "-1.314,51" / "+1.314,51"; 0 → empty. The operand
 * in the string IS the storage sign — a bare number reads as positive.
 */
export function signedAmountText(cents: Cents, formatAmount: (cents: Cents) => string): string {
  if (cents === 0) return '';
  return cents < 0 ? formatAmount(cents) : `+${formatAmount(cents)}`;
}

/** The draft a MoneyInput shows for a committed value (mount and external re-sync). */
export function moneyDraftText(
  cents: Cents,
  opts: { allowEmpty: boolean; signed: boolean },
  formatAmount: (cents: Cents) => string,
): string {
  return opts.allowEmpty && cents === 0 ? '' : opts.signed ? signedAmountText(cents, formatAmount) : formatAmount(cents);
}

/**
 * On an external value change, keep the visible draft when it already parses
 * to the new value (a currency-prefixed draft like "$10" stays after its own
 * commit) — except an `allowEmpty` field reset to 0, which must go blank.
 */
export function draftMatchesValue(
  text: string,
  cents: Cents,
  allowEmpty: boolean,
  parseMoney: (text: string) => Cents,
): boolean {
  return parseMoney(text) === cents && !(allowEmpty && cents === 0 && text !== '');
}

/**
 * What a draft commits to. Signed mode: parseMoney already reads the typed
 * operand ("-115,00" / "+115,00" / bare = positive); quick-math mode falls
 * back to the prior value on an unparseable draft; plain mode parses the
 * magnitude.
 */
export function draftCommitCents(
  text: string,
  cents: Cents,
  opts: { signed: boolean; quickMath: boolean },
  parseMoney: (text: string) => Cents,
): Cents {
  return opts.signed
    ? parseMoney(text)
    : opts.quickMath
      ? (evalQuickMath(text, cents, { parseMoney }) ?? cents)
      : parseMoney(text);
}

/**
 * qbp: a draft ending in an operator gets it replaced — '+ then ×' is
 * '5×', not '5+×' (which evalQuickMath would reject). Mid-expression
 * operators still append ('5+2' + '−' → '5+2−').
 */
export function appendQuickMathOp(text: string, op: QuickMathOp): string {
  const trimmed = text.trimEnd();
  return /[+−×÷]$/.test(trimmed) ? trimmed.slice(0, -1) + op : text + op;
}

/** Accessibility label of an operator cell in the quick-math popover. */
export function quickMathOpLabel(op: QuickMathOp): string {
  return `${op === '+' ? 'Add' : op === '−' ? 'Subtract' : op === '×' ? 'Multiply' : 'Divide'} operator`;
}

/**
 * AmountCell's storage sign in the field: outflow renders "−55,90" so editing
 * digits re-commits as an outflow (next < 0), not silently flipping to inflow.
 * An all-zero cell counts as an outflow.
 */
export function amountCellValue(outflowCents: Cents, inflowCents: Cents): { isOutflow: boolean; cents: Cents } {
  const isOutflow = outflowCents !== 0 || inflowCents === 0;
  return { isOutflow, cents: isOutflow ? -outflowCents : inflowCents };
}

/** The outflow/inflow pair a signed commit stores: negative → outflow, else inflow. */
export function amountCellPatch(next: Cents): { outflowCents: Cents; inflowCents: Cents } {
  return next < 0 ? { outflowCents: -next, inflowCents: 0 } : { outflowCents: 0, inflowCents: next };
}
