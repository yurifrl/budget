/**
 * The Plan grid's filter chips (All / Underfunded / Overfunded / Money
 * Available / Snoozed): which categories each chip keeps. Pure; the chip
 * labels live with the screen.
 */
import { assignedInMonth, neededInMonth, targetFundingState } from './engine';
import type { Category } from './types';
import { categoryFigures, type BudgetMonth } from './zeroSum';

/** Same union as `PlanFilter` in state/ui (the domain cannot import state). */
export type PlanFilterKey = 'all' | 'underfunded' | 'overfunded' | 'money-available' | 'snoozed';

export function matchesPlanFilter(category: Category, bm: BudgetMonth, filter: PlanFilterKey): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'underfunded':
      return targetFundingState(category, bm).state === 'yellow';
    case 'overfunded':
      return !!category.target && assignedInMonth(category, bm.month) > neededInMonth(category, bm.month);
    case 'money-available':
      return categoryFigures(bm, category.id).available > 0;
    case 'snoozed':
      return false;
  }
}
