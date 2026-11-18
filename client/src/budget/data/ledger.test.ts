import { describe, expect, test } from 'bun:test';

import { createSeedBudget } from '../domain/seed';
import { moveMoneyUpdates, multiMoveMoneyUpdates } from './ledger';
describe('moveMoneyUpdates', () => {
  const budget = createSeedBudget();
  const month = budget.currentMonth; // 202606: Mercado=120000, Comer Fora=5000

  test('category -> category writes both resulting absolutes', () => {
    expect(moveMoneyUpdates(budget, month, 'cat-mercado', 'cat-comer-fora', 10000)).toEqual([
      { categoryId: 'cat-mercado', assignedCents: 110000 },
      { categoryId: 'cat-comer-fora', assignedCents: 15000 },
    ]);
  });

  test('to Ready-to-Assign only lowers the source (RTA is derived)', () => {
    expect(moveMoneyUpdates(budget, month, 'cat-mercado', null, 20000)).toEqual([
      { categoryId: 'cat-mercado', assignedCents: 100000 },
    ]);
  });

  test('from Ready-to-Assign only raises the destination', () => {
    expect(moveMoneyUpdates(budget, month, null, 'cat-psiquiatra', 80000)).toEqual([
      { categoryId: 'cat-psiquiatra', assignedCents: 80000 },
    ]);
  });
});

describe('multiMoveMoneyUpdates', () => {
  const budget = createSeedBudget();
  const month = budget.currentMonth; // 202606: Mercado=120000, Comer Fora=5000

  test('accumulates deltas when one category appears in several pairs', () => {
    expect(
      multiMoveMoneyUpdates(budget, month, [
        { from: 'cat-mercado', to: 'cat-comer-fora', amount: 10000 },
        { from: 'cat-mercado', to: 'cat-psiquiatra', amount: 20000 },
        { from: 'cat-comer-fora', to: 'cat-psiquiatra', amount: 5000 },
      ]),
    ).toEqual([
      { categoryId: 'cat-mercado', assignedCents: 90000 },
      { categoryId: 'cat-comer-fora', assignedCents: 10000 },
      { categoryId: 'cat-psiquiatra', assignedCents: 25000 },
    ]);
  });

  test('drops categories whose net delta is zero and skips non-positive amounts', () => {
    expect(
      multiMoveMoneyUpdates(budget, month, [
        { from: 'cat-mercado', to: 'cat-comer-fora', amount: 10000 },
        { from: 'cat-comer-fora', to: 'cat-psiquiatra', amount: 10000 },
        { from: 'cat-mercado', to: 'cat-comer-fora', amount: 0 },
      ]),
    ).toEqual([
      { categoryId: 'cat-mercado', assignedCents: 110000 },
      { categoryId: 'cat-psiquiatra', assignedCents: 10000 },
    ]);
  });
});
