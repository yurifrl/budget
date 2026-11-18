/**
 * Category inspector engine — the Available Balance breakdown for the
 * inspector sidebar (syscd-app-nrg). PURE functions over the zero-sum engine's
 * month (`BudgetMonth`); no storage access.
 */

import type { BudgetMonth } from "./zeroSum";
import type { Cents } from "./types";

export type BreakdownKey = "carryover" | "assigned" | "activity" | "funded" | "payments";

export interface BreakdownRow {
  key: BreakdownKey;
  /** Row amount in cents, signed so the rows sum to `available` (payments are negative). */
  cents: Cents;
}

export interface AvailableBalance {
  kind: "spending" | "payment";
  /** The AVAILABLE figure the inspector highlights. */
  available: Cents;
  /** Breakdown rows; their sum is always `available`. */
  rows: BreakdownRow[];
  /** Payment categories only: the card's debt and the part of it Available does not cover. */
  debt?: Cents;
  underfunded?: Cents;
}

/**
 * YNAB-style "Available Balance" block from the engine's month.
 *
 * Spending category: carryover + assigned + activity (cash and card net).
 * Payment category: carried over + assigned + funded card spending - payments,
 * plus the card's debt and what is still underfunded.
 */
export function availableBreakdown(bm: BudgetMonth, categoryId: string): AvailableBalance {
  const payment = bm.payments[categoryId];
  if (payment) {
    return {
      kind: "payment",
      available: payment.available,
      rows: [
        { key: "carryover", cents: payment.available - payment.assigned - payment.funded + payment.payments },
        { key: "assigned", cents: payment.assigned },
        { key: "funded", cents: payment.funded },
        { key: "payments", cents: 0 - payment.payments },
      ],
      debt: payment.debt,
      underfunded: payment.underfunded,
    };
  }
  const c = bm.categories[categoryId];
  return {
    kind: "spending",
    available: c?.available ?? 0,
    rows: [
      { key: "carryover", cents: c?.carryover ?? 0 },
      { key: "assigned", cents: c?.assigned ?? 0 },
      { key: "activity", cents: c?.activity ?? 0 },
    ],
  };
}
