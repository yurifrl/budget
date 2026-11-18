/**
 * Category goal (YNAB-style target) mapping: the API's target input to the
 * categories.goal_* columns. Pure; moved out of routes/categories.ts.
 */
import type { GoalColumns } from '../store/categories';

export interface TargetInput {
  /** Milliunits. */
  amount?: number;
  cadence?: 'weekly' | 'monthly' | 'yearly' | 'custom';
  by_date?: string;
  behavior?: 'set-aside' | 'refill';
}

export function goalColumns(target: TargetInput | null): GoalColumns {
  if (!target) {
    return {
      goal_type: null,
      goal_target: null,
      goal_cadence: null,
      goal_cadence_frequency: null,
      goal_target_date: null,
      goal_needs_whole_amount: null,
    };
  }
  const milli = target.amount ?? 0;
  if (target.cadence === 'custom') {
    return {
      goal_type: 'TBD',
      goal_target: milli,
      goal_target_date: target.by_date ?? null,
      goal_cadence: null,
      goal_cadence_frequency: null,
      goal_needs_whole_amount: null,
    };
  }
  const cadence = target.cadence === 'weekly' ? 2 : target.cadence === 'yearly' ? 13 : 1;
  return {
    goal_type: 'NEED',
    goal_target: milli,
    goal_cadence: cadence,
    goal_cadence_frequency: 1,
    goal_target_date: target.cadence === 'yearly' ? (target.by_date ?? null) : null,
    goal_needs_whole_amount: target.cadence === 'monthly' ? target.behavior !== 'refill' : null,
  };
}
