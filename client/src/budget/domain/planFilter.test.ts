import { describe, expect, test } from 'bun:test';

import { matchesPlanFilter } from './planFilter';
import { cat, JUN, month } from './__fixtures__/plan.fixtures';
import type { CategoryTarget } from './types';

const monthly = (categoryId: string, amountCents: number): CategoryTarget => ({
  categoryId,
  kind: 'monthly',
  amountCents,
  config: {},
});

describe('matchesPlanFilter', () => {
  test("'all' keeps everything", () => {
    expect(matchesPlanFilter(cat('a'), month(), 'all')).toBe(true);
  });

  test("'underfunded' keeps a targeted category assigned less than it needs", () => {
    const under = cat('a', 'g1', { target: monthly('a', 10000), assigned: { [JUN]: 4000 } });
    const funded = cat('b', 'g1', { target: monthly('b', 10000), assigned: { [JUN]: 10000 } });
    expect(matchesPlanFilter(under, month(), 'underfunded')).toBe(true);
    expect(matchesPlanFilter(funded, month(), 'underfunded')).toBe(false);
  });

  test("'underfunded' drops categories with no target, and overspent ones (red wins over yellow)", () => {
    expect(matchesPlanFilter(cat('a'), month(), 'underfunded')).toBe(false);
    const under = cat('a', 'g1', { target: monthly('a', 10000), assigned: { [JUN]: 4000 } });
    expect(matchesPlanFilter(under, month({ a: { cashOverspend: 100 } }), 'underfunded')).toBe(false);
    expect(matchesPlanFilter(under, month({ a: { creditOverspend: 100 } }), 'underfunded')).toBe(false);
  });

  test("'overfunded' needs a target and strictly more assigned than needed", () => {
    const over = cat('a', 'g1', { target: monthly('a', 10000), assigned: { [JUN]: 10001 } });
    const exact = cat('b', 'g1', { target: monthly('b', 10000), assigned: { [JUN]: 10000 } });
    const noTarget = cat('c', 'g1', { assigned: { [JUN]: 99999 } });
    expect(matchesPlanFilter(over, month(), 'overfunded')).toBe(true);
    expect(matchesPlanFilter(exact, month(), 'overfunded')).toBe(false);
    expect(matchesPlanFilter(noTarget, month(), 'overfunded')).toBe(false);
  });

  test("'overfunded' reads the assignment of the engine's month only", () => {
    const c = cat('a', 'g1', { target: monthly('a', 10000), assigned: { 202605: 50000 } });
    expect(matchesPlanFilter(c, month(), 'overfunded')).toBe(false);
  });

  test("'money-available' keeps strictly positive Available (engine figures, unknown id = 0)", () => {
    const bm = month({ a: { available: 1 }, b: { available: 0 }, c: { available: -5 } });
    expect(matchesPlanFilter(cat('a'), bm, 'money-available')).toBe(true);
    expect(matchesPlanFilter(cat('b'), bm, 'money-available')).toBe(false);
    expect(matchesPlanFilter(cat('c'), bm, 'money-available')).toBe(false);
    expect(matchesPlanFilter(cat('zz'), bm, 'money-available')).toBe(false);
  });

  test("'snoozed' matches nothing (not implemented), even a snoozed target", () => {
    const snoozed = cat('a', 'g1', { target: { ...monthly('a', 10000), snoozeMonth: JUN } });
    expect(matchesPlanFilter(snoozed, month(), 'snoozed')).toBe(false);
  });
});
