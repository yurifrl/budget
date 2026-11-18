/**
 * Figures one Plan category row derives for display: the funding-bar
 * fraction, the AVAILABLE pill's progress ring and the phone numpad's live
 * equation in the ASSIGNED cell. Pure.
 */
import type { MoneyFormat } from './format';
import { numpadOperandText, type NumpadState } from './quickmath';
import { neededBy } from './targets';
import type { CategoryTarget, Cents, MonthKey } from './types';

/** Funded share of this month's need; with no need, full when money is available, else empty. */
export function fundingFraction(
  funding: { neededThisMonth: Cents; fundedSoFar: Cents },
  available: Cents,
): number {
  return funding.neededThisMonth > 0 ? funding.fundedSoFar / funding.neededThisMonth : available > 0 ? 1 : 0;
}

/**
 * Progress shown on the AVAILABLE pill. With a target: assigned vs the
 * target's need for `month`, clamped to 0..1 (null when nothing is needed).
 * Without a target: the funding fraction.
 */
export function pillProgress(
  target: CategoryTarget | null,
  month: MonthKey,
  assigned: Cents,
  fraction: number,
): number | null {
  if (target == null) return fraction;
  const needed = neededBy(target, month);
  return needed > 0 ? Math.min(1, Math.max(0, assigned / needed)) : null;
}

/** The numpad equation as the row's ASSIGNED cell shows it (the caret is added by the cell). */
export interface NumpadCellText {
  /** Stacked equation only: the old number on the top line (null under '='). */
  base: string | null;
  /** The line being typed: '+ R$ 1,00' under an operator, else the operand or the base. */
  pending: string;
}

export function numpadCellText(
  state: NumpadState,
  assigned: Cents,
  { formatMoney }: Pick<MoneyFormat, 'formatMoney'>,
): NumpadCellText {
  if (state.op !== '=') {
    // Stacked equation: old number on top, the pending '+operand' under (YNAB parity).
    return {
      base: formatMoney(state.base ?? assigned),
      pending: state.op + (state.operand ? ` ${numpadOperandText(state.operand, { formatMoney })}` : ''),
    };
  }
  // Single line under '=': the typed operand, or the (possibly just-resolved) base.
  return {
    base: null,
    pending: state.operand
      ? numpadOperandText(state.operand, { formatMoney })
      : formatMoney(state.base ?? assigned),
  };
}
