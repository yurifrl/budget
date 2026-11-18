/**
 * Plan-row / inspector hints for the two "yellow" states (docs/budget-engine-spec.md
 * §2-3): a card payment envelope that does not cover the card's debt
 * (underfunded) and a spending category overspent on credit (the overspend
 * moves into card debt). PURE over the engine's month; components stay thin.
 */

import { formatMoney } from "./format";
import type { BudgetMonth } from "./zeroSum";

export interface OverspendHint {
  /** Short secondary line for the Plan row. */
  label: string;
  /** Full sentence for the inspector / detail view and row tooltip. */
  detail: string;
}

/** "Underfunded R$ X" for a card payment category with `underfunded > 0`, else null. */
export function underfundedHint(bm: BudgetMonth, categoryId: string): OverspendHint | null {
  const underfunded = bm.payments[categoryId]?.underfunded ?? 0;
  if (underfunded <= 0) return null;
  const amount = formatMoney(underfunded);
  return {
    label: `Underfunded ${amount}`,
    detail: `${amount} more is needed to cover this card's debt`,
  };
}

/** Hint for a spending category overspent on credit (`creditOverspend > 0`), else null. */
export function creditOverspendHint(bm: BudgetMonth, categoryId: string): OverspendHint | null {
  const credit = bm.categories[categoryId]?.creditOverspend ?? 0;
  if (credit <= 0) return null;
  const amount = formatMoney(credit);
  return {
    label: `${amount} on credit`,
    detail: `${amount} spent on credit with no money assigned: added to card debt`,
  };
}

/** Whichever hint applies to a category (payment categories first). */
export function overspendHint(bm: BudgetMonth, categoryId: string): OverspendHint | null {
  return underfundedHint(bm, categoryId) ?? creditOverspendHint(bm, categoryId);
}
