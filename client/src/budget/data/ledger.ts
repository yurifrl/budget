/**
 * Pure ledger helpers for budget mutations.
 *
 * Account balances are derived server-side from the transaction rows; this
 * file only computes the move-money assignment updates as pure data, so the
 * api layer just persists and the logic stays unit-testable.
 */

import { assignedInMonth } from '../domain/engine';
import type { Budget, Cents, MonthKey } from '../domain/types';

export interface AssignmentUpdate {
  categoryId: string;
  assignedCents: Cents;
}

/**
 * Move money between categories (or to/from Ready-to-Assign when an end is
 * null). Returns the resulting ABSOLUTE assigned values to persist — the spec
 * requires both categories to be written as absolutes, and RTA needs no write
 * at all (it is derived as funds − total assigned).
 */
/** One move: `amount` flows from→to (either end null = Ready-to-Assign). */
export interface MovePair {
  from: string | null;
  to: string | null;
  amount: Cents;
}

/**
 * Multi-pair variant of `moveMoneyUpdates`: folds every pair into per-category
 * DELTAS first, then emits one absolute update per touched category — so
 * several pairs touching the same category (e.g. two sources into one target)
 * accumulate instead of each pair computing absolutes from the original budget.
 * Ready-to-Assign endpoints never enter the output (RTA is derived).
 */
export function multiMoveMoneyUpdates(
  budget: Budget,
  month: MonthKey,
  pairs: readonly MovePair[],
): AssignmentUpdate[] {
  const assignedOf = (categoryId: string): Cents => {
    const cat = budget.categories.find((c) => c.id === categoryId);
    return cat ? assignedInMonth(cat, month) : 0;
  };
  const deltas: Record<string, Cents> = {};
  for (const { from, to, amount } of pairs) {
    if (amount <= 0) continue;
    if (from) deltas[from] = (deltas[from] ?? 0) - amount;
    if (to) deltas[to] = (deltas[to] ?? 0) + amount;
  }
  return Object.entries(deltas)
    .filter(([, delta]) => delta !== 0)
    .map(([categoryId, delta]) => ({ categoryId, assignedCents: assignedOf(categoryId) + delta }));
}

export function moveMoneyUpdates(
  budget: Budget,
  month: MonthKey,
  fromCategoryId: string | null,
  toCategoryId: string | null,
  amount: Cents,
): AssignmentUpdate[] {
  return multiMoveMoneyUpdates(budget, month, [{ from: fromCategoryId, to: toCategoryId, amount }]);
}
