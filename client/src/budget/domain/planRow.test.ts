import { describe, expect, test } from 'bun:test';

import { fundingFraction, numpadCellText, pillProgress } from './planRow';
import { JUN } from './__fixtures__/plan.fixtures';
import type { CategoryTarget } from './types';

const fmt = { formatMoney: (cents: number) => `$${cents}` };
const monthly = (amountCents: number): CategoryTarget => ({ categoryId: 'a', kind: 'monthly', amountCents, config: {} });

describe('fundingFraction', () => {
  test('funded share of the need, not clamped', () => {
    expect(fundingFraction({ neededThisMonth: 200, fundedSoFar: 50 }, 0)).toBe(0.25);
    expect(fundingFraction({ neededThisMonth: 200, fundedSoFar: 300 }, 0)).toBe(1.5);
    expect(fundingFraction({ neededThisMonth: 200, fundedSoFar: -100 }, 999)).toBe(-0.5);
  });

  test('nothing needed: full when money is available, else empty', () => {
    expect(fundingFraction({ neededThisMonth: 0, fundedSoFar: 50 }, 1)).toBe(1);
    expect(fundingFraction({ neededThisMonth: 0, fundedSoFar: 50 }, 0)).toBe(0);
    expect(fundingFraction({ neededThisMonth: 0, fundedSoFar: 50 }, -1)).toBe(0);
  });
});

describe('pillProgress', () => {
  test('no target: the funding fraction as given', () => {
    expect(pillProgress(null, JUN, 123, 0.4)).toBe(0.4);
    expect(pillProgress(null, JUN, 123, 1.5)).toBe(1.5);
  });

  test('with a target: assigned over the need, clamped to 0..1, ignoring the fraction', () => {
    expect(pillProgress(monthly(1000), JUN, 250, 9)).toBe(0.25);
    expect(pillProgress(monthly(1000), JUN, 5000, 9)).toBe(1);
    expect(pillProgress(monthly(1000), JUN, -10, 9)).toBe(0);
  });

  test('a target that needs nothing this month has no progress', () => {
    expect(pillProgress(monthly(0), JUN, 250, 0.4)).toBeNull();
  });
});

describe('numpadCellText', () => {
  test("pristine '=': one line with the current assigned", () => {
    expect(numpadCellText({ base: null, op: '=', operand: '' }, 700, fmt)).toEqual({ base: null, pending: '$700' });
  });

  test("'=' with digits: the typed operand (digits are cents); with a resolved base: the base", () => {
    expect(numpadCellText({ base: null, op: '=', operand: '063' }, 700, fmt)).toEqual({ base: null, pending: '$63' });
    expect(numpadCellText({ base: 1200, op: '=', operand: '' }, 700, fmt)).toEqual({ base: null, pending: '$1200' });
    expect(numpadCellText({ base: 0, op: '=', operand: '' }, 700, fmt)).toEqual({ base: null, pending: '$0' });
  });

  test('operator pending: the old number on top, the bare operator under it', () => {
    expect(numpadCellText({ base: 1200, op: '+', operand: '' }, 700, fmt)).toEqual({ base: '$1200', pending: '+' });
    expect(numpadCellText({ base: null, op: '−', operand: '' }, 700, fmt)).toEqual({ base: '$700', pending: '−' });
  });

  test('operator with digits: operator, a space, the operand', () => {
    expect(numpadCellText({ base: 1200, op: '−', operand: '50' }, 700, fmt)).toEqual({ base: '$1200', pending: '− $50' });
  });
});
