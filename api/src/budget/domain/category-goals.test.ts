/** Characterisation of goalColumns (moved verbatim from routes/categories.ts). */
import { describe, expect, test } from 'bun:test';

import { goalColumns } from './category-goals';

const none = {
  goal_type: null,
  goal_target: null,
  goal_cadence: null,
  goal_cadence_frequency: null,
  goal_target_date: null,
  goal_needs_whole_amount: null,
};

describe('goalColumns', () => {
  test('null clears every goal column', () => {
    expect(goalColumns(null)).toEqual(none);
  });

  test('custom: TBD with the by-date, milliunits', () => {
    expect(goalColumns({ cadence: 'custom', amount: 12_340, by_date: '2026-12-01' })).toEqual({
      ...none,
      goal_type: 'TBD',
      goal_target: 12_340,
      goal_target_date: '2026-12-01',
    });
  });

  test('monthly: NEED, cadence 1, whole amount unless refill', () => {
    expect(goalColumns({ cadence: 'monthly', amount: 1000 })).toEqual({
      goal_type: 'NEED',
      goal_target: 1000,
      goal_cadence: 1,
      goal_cadence_frequency: 1,
      goal_target_date: null,
      goal_needs_whole_amount: true,
    });
    expect(goalColumns({ cadence: 'monthly', amount: 1000, behavior: 'refill' }).goal_needs_whole_amount).toBe(false);
  });

  test('weekly cadence 2; yearly cadence 13 keeps the by-date; default is monthly cadence with no whole-amount flag', () => {
    expect(goalColumns({ cadence: 'weekly', amount: 10 })).toMatchObject({ goal_cadence: 2, goal_needs_whole_amount: null });
    expect(goalColumns({ cadence: 'yearly', amount: 10, by_date: '2027-01-01' })).toMatchObject({
      goal_cadence: 13,
      goal_target_date: '2027-01-01',
    });
    expect(goalColumns({})).toMatchObject({ goal_type: 'NEED', goal_target: 0, goal_cadence: 1, goal_needs_whole_amount: null });
  });
});
