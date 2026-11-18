/**
 * Auto-Assign panel strategies (bead syscd-app-glm) — the pure half of the
 * YNAB Auto-Assign sidebar (docs/ynab-ref/auto-assign-panel.png).
 *
 * Each strategy computes, per category, the absolute assignment the category
 * should hold for the month (`assignCents`) and the change from what it
 * currently holds (`deltaCents`). Rows only appear where applying would
 * actually change the assignment; the UI lets the user exclude rows before
 * the server route writes the kept ones.
 *
 * Semantics (YNAB parity, bead acceptance):
 *  - underfunded        fill categories whose target is underfunded this
 *                       month up to `neededBy` — the same shortfall the plan
 *                       rows badge (assigned vs needed, not available). A card
 *                       payment category fills its engine `underfunded` (card
 *                       debt its Available does not cover).
 *  - assignedLastMonth  copy last month's assignments.
 *  - spentLastMonth     assign what was spent last month (net outflow).
 *  - averageAssigned    average monthly assignment over the last 3 months.
 *  - averageSpent       average monthly outflow over the last 3 months.
 *  - reduceOverfunding  pull categories funded past their target back to it.
 *  - resetAvailable     adjust assignments so every available lands on 0
 *                       (frees carryover back to Ready to Assign).
 *  - resetAssigned      zero out the month's assignments.
 *
 * Averages look at the last 3 months of history, never before the budget's
 * first month, and skip categories with no trace in that window. Suggestions
 * only ever set positive amounts; pulling money out is the explicit job of
 * the action strategies.
 */

import type { Budget, CategoryTarget, Cents, MonthKey } from "./types";
import { prevMonth } from "./format";
import { recomputeActivity } from "./engine";
import { budgetMonth, categoryFigures, type FigureKind } from "./zeroSum";
import { neededBy } from "./targets";

/** Past months the average strategies look at (YNAB ref: "Average Assigned (6mo)"). */
export const AVERAGE_MONTHS = 6;

export type AutoAssignStrategyKey =
  | "underfunded"
  | "assignedLastMonth"
  | "spentLastMonth"
  | "averageAssigned"
  | "averageSpent"
  | "reduceOverfunding"
  | "resetAvailable"
  | "resetAssigned";

/** Panel order: suggestions first, then the action strategies. */
export const AUTO_ASSIGN_STRATEGIES: readonly AutoAssignStrategyKey[] = [
  "underfunded",
  "assignedLastMonth",
  "spentLastMonth",
  "averageAssigned",
  "averageSpent",
  "reduceOverfunding",
  "resetAvailable",
  "resetAssigned",
];

export const AVERAGE_STRATEGIES: readonly AutoAssignStrategyKey[] = ["averageAssigned", "averageSpent"];

/** A category's per-month history plus its (optional) nc5 target. */
export interface AutoAssignCategory {
  id: string;
  name: string;
  groupName: string;
  /** month → assigned (cents). Missing month => 0. */
  assigned: Record<MonthKey, Cents>;
  /** month → net activity, inflow − outflow (cents). Missing month => 0. Derived from transactions. */
  activity: Record<MonthKey, Cents>;
  /** Spending or card payment category (engine figures). */
  kind: FigureKind;
  /** The engine's Available for the snapshot month (unified: payment Available for payment categories). */
  available: Cents;
  /** Payment categories: card debt not covered by Available (`PaymentMonth.underfunded`); 0 otherwise. */
  underfunded: Cents;
  target: CategoryTarget | null;
}

export interface AutoAssignSnapshot {
  /** Month being funded (YYYYMM). */
  month: MonthKey;
  /** First month with budget history; averages never look earlier. */
  startMonth: MonthKey;
  categories: AutoAssignCategory[];
}

/** One category's suggested assignment. */
export interface AutoAssignRow {
  categoryId: string;
  /** Absolute assignment the category should hold after applying (cents). */
  assignCents: Cents;
  /** Change from the current assignment (negative frees money). */
  deltaCents: Cents;
}

export interface AutoAssignStrategy {
  key: AutoAssignStrategyKey;
  rows: AutoAssignRow[];
  /** Sum of deltas across rows (cents). */
  totalCents: Cents;
  /** Months averaged over — set for the average strategies only. */
  monthsUsed: MonthKey[];
}

function at(rec: Record<MonthKey, Cents>, month: MonthKey): Cents {
  return rec[month] ?? 0;
}

/**
 * The last `count` months of history strictly before `month`, never earlier
 * than the budget's first month. Younger budgets average over fewer months.
 */
export function historyMonths(month: MonthKey, startMonth: MonthKey, count = AVERAGE_MONTHS): MonthKey[] {
  const months: MonthKey[] = [];
  let m = prevMonth(month);
  while (months.length < count && m >= startMonth) {
    months.push(m);
    m = prevMonth(m);
  }
  return months;
}

/** Rows only where the suggestion would change the current assignment. */
function buildRows(
  snap: AutoAssignSnapshot,
  suggest: (c: AutoAssignCategory) => Cents | null,
): AutoAssignRow[] {
  const rows: AutoAssignRow[] = [];
  for (const c of snap.categories) {
    const assign = suggest(c);
    if (assign === null) continue;
    const current = at(c.assigned, snap.month);
    if (assign !== current) {
      rows.push({ categoryId: c.id, assignCents: assign, deltaCents: assign - current });
    }
  }
  return rows;
}

/** Rounded mean of `value` over the window. */
function average(c: AutoAssignCategory, months: MonthKey[], value: (m: MonthKey) => Cents): Cents {
  const total = months.reduce((sum, m) => sum + value(m), 0);
  return Math.round(total / months.length);
}

/** Compute one strategy's rows for the snapshot. */
export function buildAutoAssignStrategy(snap: AutoAssignSnapshot, key: AutoAssignStrategyKey): AutoAssignStrategy {
  const prev = prevMonth(snap.month);
  let rows: AutoAssignRow[] = [];
  let monthsUsed: MonthKey[] = [];

  switch (key) {
    case "underfunded":
      rows = buildRows(snap, (c) => {
        if (c.kind === "payment") return c.underfunded > 0 ? at(c.assigned, snap.month) + c.underfunded : null;
        if (!c.target) return null;
        const need = neededBy(c.target, snap.month);
        return need > at(c.assigned, snap.month) ? need : null;
      });
      break;
    case "assignedLastMonth":
      rows = buildRows(snap, (c) => {
        const last = at(c.assigned, prev);
        return last > 0 ? last : null;
      });
      break;
    case "spentLastMonth":
      rows = buildRows(snap, (c) => {
        const spent = Math.max(0, -at(c.activity, prev));
        return spent > 0 ? spent : null;
      });
      break;
    case "averageAssigned":
    case "averageSpent": {
      monthsUsed = historyMonths(snap.month, snap.startMonth);
      if (monthsUsed.length === 0) break;
      rows = buildRows(snap, (c) => {
        if (monthsUsed.every((m) => !c.assigned[m] && !c.activity[m])) return null;
        const avg = average(c, monthsUsed, (m) =>
          key === "averageAssigned" ? at(c.assigned, m) : Math.max(0, -at(c.activity, m)),
        );
        return avg > 0 ? avg : null;
      });
      break;
    }
    case "reduceOverfunding":
      rows = buildRows(snap, (c) => {
        if (!c.target) return null;
        const need = neededBy(c.target, snap.month);
        return at(c.assigned, snap.month) > need ? need : null;
      });
      break;
    case "resetAvailable":
      rows = buildRows(snap, (c) => {
        const avail = c.available;
        return avail !== 0 ? at(c.assigned, snap.month) - avail : null;
      });
      break;
    case "resetAssigned":
      rows = buildRows(snap, (c) => (at(c.assigned, snap.month) !== 0 ? 0 : null));
      break;
  }

  return {
    key,
    rows,
    totalCents: rows.reduce((sum, r) => sum + r.deltaCents, 0),
    monthsUsed,
  };
}

/** Every panel strategy for the snapshot, in panel order. */
export function buildAutoAssignStrategies(snap: AutoAssignSnapshot): AutoAssignStrategy[] {
  return AUTO_ASSIGN_STRATEGIES.map((key) => buildAutoAssignStrategy(snap, key));
}

/**
 * Snapshot for the panel from a client budget. Categories follow group display
 * order (panel rows group the same way the plan list does). A budget without
 * history starts its average windows at the funded month. Available and
 * underfunded come from the zero-sum engine; the spend history is derived from
 * the transactions.
 */
export function buildAutoAssignSnapshot(budget: Budget, month: MonthKey): AutoAssignSnapshot {
  const bm = budgetMonth(budget, month);
  const activity = recomputeActivity(budget);
  const categories = budget.groups.flatMap((g) =>
    budget.categories
      .filter((c) => c.groupId === g.id)
      .map((c) => {
        const figures = categoryFigures(bm, c.id);
        return {
          id: c.id,
          name: c.name,
          groupName: g.name,
          assigned: c.assigned,
          activity: activity[c.id] ?? {},
          kind: figures.kind,
          available: figures.available,
          underfunded: bm.payments[c.id]?.underfunded ?? 0,
          target: c.target ?? null,
        };
      }),
  );
  return {
    month,
    startMonth: budget.months.length > 0 ? budget.months[0] : month,
    categories,
  };
}
