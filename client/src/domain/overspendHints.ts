/**
 * Plan-row / inspector hints for the two "yellow" states (docs/budget-engine-spec.md
 * §2-3): a card payment envelope that does not cover the card's debt
 * (underfunded) and a spending category overspent on credit (the overspend
 * moves into card debt). PURE over the engine's month; components stay thin.
 */

import { DEFAULT_MONEY_FORMAT, type MoneyFormat } from "./format";
import { t } from "./i18n";
import type { BudgetMonth } from "./zeroSum";

export interface OverspendHint {
  /** Short secondary line for the Plan row. */
  label: string;
  /** Full sentence for the inspector / detail view and row tooltip. */
  detail: string;
}

/** "Underfunded R$ X" for a card payment category with `underfunded > 0`, else null. */
export function underfundedHint(
  bm: BudgetMonth,
  categoryId: string,
  fmt: Pick<MoneyFormat, "formatMoney"> = DEFAULT_MONEY_FORMAT,
): OverspendHint | null {
  const underfunded = bm.payments[categoryId]?.underfunded ?? 0;
  if (underfunded <= 0) return null;
  const amount = fmt.formatMoney(underfunded);
  return {
    label: t('overspend.underfundedLabel', { amount }),
    detail: t('overspend.underfundedDetail', { amount }),
  };
}

/** Hint for a spending category overspent on credit (`creditOverspend > 0`), else null. */
export function creditOverspendHint(
  bm: BudgetMonth,
  categoryId: string,
  fmt: Pick<MoneyFormat, "formatMoney"> = DEFAULT_MONEY_FORMAT,
): OverspendHint | null {
  const credit = bm.categories[categoryId]?.creditOverspend ?? 0;
  if (credit <= 0) return null;
  const amount = fmt.formatMoney(credit);
  return {
    label: t('overspend.creditLabel', { amount }),
    detail: t('overspend.creditDetail', { amount }),
  };
}

/** Whichever hint applies to a category (payment categories first). */
export function overspendHint(
  bm: BudgetMonth,
  categoryId: string,
  fmt: Pick<MoneyFormat, "formatMoney"> = DEFAULT_MONEY_FORMAT,
): OverspendHint | null {
  return underfundedHint(bm, categoryId, fmt) ?? creditOverspendHint(bm, categoryId, fmt);
}
