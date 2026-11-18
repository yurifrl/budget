/**
 * Budgeting helpers around the engine — PURE functions. Bead ynabu-3dn.6, PDD §2.
 *
 * NOT a second engine: month figures (Available, overspending, card payment
 * envelopes, Ready to Assign) come only from `zeroSum.ts`
 * (`computeBudgetMonth`, docs/budget-engine-spec.md), which is canonical.
 * This module holds what sits around it: account balances, per-month
 * assigned lookups, target funding state, Cost to Be Me, the legacy
 * `category.activity` recompute (used by data/mapping; the engine never
 * reads it) and group rollups (which sum zeroSum figures).
 *
 * Design rules (from the bead):
 *  - Money in -> Ready to Assign pool -> user assigns until RTA = 0 (zero-based).
 *  - Recompute, never store stale derived values.
 *  - Target funding-progress compares ASSIGNED vs TARGET (NOT available vs target),
 *    so a category stays GREEN after being spent down.
 *
 * All amounts are integer cents.
 */

import { monthOfDate } from "./format";
import { neededBy } from "./targets";
import { sumFigures, type BudgetMonth, type FigureTotals } from "./zeroSum";
import type {
  Account,
  Budget,
  Category,
  Cents,
  MonthKey,
  TargetFundingResult,
  Transaction,
} from "./types";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Account balances
// ---------------------------------------------------------------------------

/** Working Balance = Cleared + Uncleared (PDD §2, §4.5). */
export function workingBalance(account: Account): Cents {
  return account.clearedBalance + account.unclearedBalance;
}

/**
 * Running balance per transaction (register column, syscd-app-ojj): the
 * newest row carries the account's working balance and the column walks
 * backwards through the register — each older row shows the balance as it
 * stood before the newer transaction applied. `rows` must be newest-first
 * (the register's display order). Callers scope by account and date cutoff;
 * filters never distort the numbers because they only drop whole rows.
 */
export function computeRunningBalances(
  rows: Pick<Transaction, "id" | "inflow" | "outflow">[],
  working: Cents,
): Map<string, Cents> {
  const map = new Map<string, Cents>();
  let bal = working;
  for (const row of rows) {
    map.set(row.id, bal);
    bal = bal - row.inflow + row.outflow;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Assigned
// ---------------------------------------------------------------------------
// Ready to Assign and every Available / Activity figure come from the zero-sum
// engine (`zeroSum.ts`, docs/budget-engine-spec.md); nothing here derives them.

/** Assigned to a category in a single month (0 if none). */
export function assignedInMonth(category: Pick<Category, "assigned">, month: MonthKey): Cents {
  return category.assigned[month] ?? 0;
}

// ---------------------------------------------------------------------------
// Target funding state (the yellow/green/gray/red pill)
// ---------------------------------------------------------------------------

/**
 * Amount a category needs assigned in `month` to be on-track for its target.
 * - monthly: the full target amount every month.
 * - by-date: the full target amount while the due month is still in the future
 *   (or is the current month); 0 once the due date has passed.
 * No target => 0.
 */
export function neededInMonth(category: Category, month: MonthKey): Cents {
  return category.target ? neededBy(category.target, month) : 0;
}

/**
 * Pill state for a category in the engine's month (`bm.month`).
 *
 * Spending category:
 *  - RED    = any cash overspend (takes precedence).
 *  - CREDIT = only credit overspend (debt without cash behind it); rendered
 *             with the yellow/warning style and wins over the target state.
 *  - then the target funding-progress, ASSIGNED vs TARGET (not available vs
 *    target, so a category stays green after being spent down):
 *    GREEN = funded (incl. no target with positive available), YELLOW = has a
 *    target but underfunded, GRAY = no target and nothing available.
 * Payment category:
 *  - RED    = negative available (paid more than was available).
 *  - YELLOW = card debt not covered (`underfunded > 0`); the result carries
 *             `underfunded` so detail views can say so.
 *  - otherwise GREEN for positive available, GRAY for zero.
 */
export function targetFundingState(category: Category, bm: BudgetMonth): TargetFundingResult {
  const month = bm.month;
  const fundedSoFar = assignedInMonth(category, month);
  const neededThisMonth = neededInMonth(category, month);
  const gap = Math.max(0, neededThisMonth - fundedSoFar);

  const payment = bm.payments[category.id];
  if (payment) {
    if (payment.available < 0) return { state: "red", neededThisMonth: 0, fundedSoFar, gap: 0 };
    if (payment.underfunded > 0) {
      return { state: "yellow", neededThisMonth: 0, fundedSoFar, gap: 0, underfunded: payment.underfunded };
    }
    return { state: payment.available > 0 ? "green" : "gray", neededThisMonth: 0, fundedSoFar, gap: 0 };
  }

  const spending = bm.categories[category.id];
  const available = spending?.available ?? 0;
  if (spending && spending.cashOverspend > 0) {
    return { state: "red", neededThisMonth, fundedSoFar, gap };
  }
  if (spending && spending.creditOverspend > 0) {
    return { state: "credit", neededThisMonth, fundedSoFar, gap };
  }

  if (category.target) {
    if (fundedSoFar >= neededThisMonth) {
      return { state: "green", neededThisMonth, fundedSoFar, gap: 0 };
    }
    return { state: "yellow", neededThisMonth, fundedSoFar, gap };
  }

  // No target.
  if (available > 0) {
    return { state: "green", neededThisMonth: 0, fundedSoFar, gap: 0 };
  }
  return { state: "gray", neededThisMonth: 0, fundedSoFar, gap: 0 };
}

// ---------------------------------------------------------------------------
// Cost to Be Me
// ---------------------------------------------------------------------------

/** Cost to Be Me = sum of all category targets for the month (PDD §2, §3.7). */
export function costToBeMe(budget: Budget, month: MonthKey): Cents {
  return budget.categories.reduce(
    (sum, c) => sum + neededInMonth(c, month),
    0,
  );
}

/**
 * Total assigned in months strictly AFTER `month` (YNAB "Assigned in Future
 * Months"). `assigned` is sparse — only months with money set carry keys, so
 * sum every entry beyond the viewed month. Callers navigate to nextMonth.
 */
export function assignedInFutureMonths(budget: Budget, month: MonthKey): Cents {
  let total: Cents = 0;
  for (const category of budget.categories) {
    for (const key of Object.keys(category.assigned)) {
      const m = Number(key) as MonthKey;
      if (m > month) total += category.assigned[m] ?? 0;
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Activity derivation (transactions -> per-category per-month activity)
// ---------------------------------------------------------------------------

/** Signed activity contribution of a transaction: inflow positive, outflow negative. */
export function transactionActivity(txn: Transaction): Cents {
  return txn.inflow - txn.outflow;
}

/**
 * Recompute the activity map for every category from the budget's transactions.
 * Returns a new map keyed by categoryId -> (MonthKey -> cents). The store uses
 * this to keep Category.activity in sync after adding/editing transactions.
 *
 * Upcoming repeat-rule occurrences (materialized future instances,
 * syscd-app-pya) are NOT activity: their money has not left the account yet —
 * YNAB semantics. The server flips `upcoming` false when the date passes.
 */
export function recomputeActivity(
  budget: Budget,
): Record<string, Record<MonthKey, Cents>> {
  const result: Record<string, Record<MonthKey, Cents>> = {};
  for (const txn of budget.transactions) {
    if (txn.upcoming) continue;
    const month = monthOfDate(txn.date);
    // Splits attribute activity per leg (syscd-app-rlt): the parent carries
    // no category, each leg owns its own.
    const legs = txn.splits?.length
      ? txn.splits.map((s) => ({ categoryId: s.categoryId, activity: s.inflow - s.outflow }))
      : txn.categoryId
        ? [{ categoryId: txn.categoryId, activity: transactionActivity(txn) }]
        : [];
    for (const leg of legs) {
      if (!leg.categoryId) continue;
      const byMonth = (result[leg.categoryId] ??= {});
      byMonth[month] = (byMonth[month] ?? 0) + leg.activity;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Group roll-ups
// ---------------------------------------------------------------------------

export type GroupRollup = FigureTotals;

/** Roll up assigned/activity/available totals for a group from the engine's month (payment categories included). */
export function groupRollup(budget: Budget, bm: BudgetMonth, groupId: string): GroupRollup {
  return sumFigures(
    bm,
    budget.categories.filter((c) => c.groupId === groupId).map((c) => c.id),
  );
}
