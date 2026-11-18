import { describe, expect, test } from 'bun:test';

import {
  BUDGET_UI_KEY,
  budgetUiReducer,
  currentMonthKey,
  monthKeyFromDate,
  selectActiveBudgetId,
  selectActiveMonth,
  selectPlanFilter,
  selectPersonFilter,
  setPersonFilter,
  selectSelectedCategoryId,
  selectCategory,
  setActiveBudget,
  setActiveMonth,
  setPlanFilter,
  toggleProgressBars,
} from './ui';

const init = () => budgetUiReducer(undefined, { type: '@@INIT' });

describe('personFilter', () => {
  test("defaults to 'all'; setPersonFilter stores 'shared' or a user id; selector reads it", () => {
    let s = init();
    expect(s.personFilter).toBe('all');
    s = budgetUiReducer(s, setPersonFilter('shared'));
    expect(selectPersonFilter({ [BUDGET_UI_KEY]: s })).toBe('shared');
    s = budgetUiReducer(s, setPersonFilter('3f2a-user'));
    expect(s.personFilter).toBe('3f2a-user');
  });
  test("setActiveBudget resets it to 'all'", () => {
    let s = budgetUiReducer(init(), setPersonFilter('u1'));
    s = budgetUiReducer(s, setActiveBudget('b-2'));
    expect(s.personFilter).toBe('all');
  });
});

describe('budgetUi slice', () => {
  test('initial state focuses the current real-world month with no budget', () => {
    const s = init();
    expect(s.activeBudgetId).toBeNull();
    // Delegation pin — monthKeyFromDate is literal-pinned below, so this holds
    // only if currentMonthKey() computes the real current month.
    expect(s.activeMonth).toBe(currentMonthKey());
    expect(s.planFilter).toBe('all');
    expect(s.showProgressBars).toBe(true);
  });

  test('switching budget clears the budget-local category selection', () => {
    let s = init();
    s = budgetUiReducer(s, selectCategory('cat-1'));
    expect(s.selectedCategoryId).toBe('cat-1');
    s = budgetUiReducer(s, setActiveBudget('b-2'));
    expect(s.activeBudgetId).toBe('b-2');
    expect(s.selectedCategoryId).toBeNull();
  });

  test('setActiveBudget(null) clears selection and unsets the budget', () => {
    let s = init();
    s = budgetUiReducer(s, setActiveBudget('b-1'));
    s = budgetUiReducer(s, selectCategory('cat-1'));
    s = budgetUiReducer(s, setActiveBudget(null));
    expect(s.activeBudgetId).toBeNull();
    // First-budget fallback must be reachable: no stale selection survives.
    expect(s.selectedCategoryId).toBeNull();
  });

  test('selectCategory(null) deselects', () => {
    let s = init();
    s = budgetUiReducer(s, selectCategory('cat-1'));
    s = budgetUiReducer(s, selectCategory(null));
    expect(s.selectedCategoryId).toBeNull();
  });

  test('unknown action leaves state untouched', () => {
    const s = budgetUiReducer(init(), selectCategory('cat-1'));
    const before = { ...s };
    const after = budgetUiReducer(s, { type: '@@unknown' });
    expect(after).toEqual(before);
  });

  test('month, filter and progress-bar toggles', () => {
    let s = init();
    s = budgetUiReducer(s, setActiveMonth(202607));
    s = budgetUiReducer(s, setPlanFilter('underfunded'));
    s = budgetUiReducer(s, toggleProgressBars());
    expect(s.activeMonth).toBe(202607);
    expect(s.planFilter).toBe('underfunded');
    expect(s.showProgressBars).toBe(false);
  });

  test('selectors read through the module key', () => {
    let s = budgetUiReducer(init(), setActiveBudget('b-1'));
    s = budgetUiReducer(s, setActiveMonth(202607));
    s = budgetUiReducer(s, selectCategory('cat-1'));
    s = budgetUiReducer(s, setPlanFilter('overfunded'));
    const root = { [BUDGET_UI_KEY]: s };
    expect(selectActiveBudgetId(root)).toBe('b-1');
    expect(selectActiveMonth(root)).toBe(202607);
    expect(selectSelectedCategoryId(root)).toBe('cat-1');
    expect(selectPlanFilter(root)).toBe('overfunded');
  });
});

describe('monthKeyFromDate', () => {
  test('literal-dated month computation', () => {
    expect(monthKeyFromDate(new Date(2026, 5, 5))).toBe(202606);
    expect(monthKeyFromDate(new Date(2024, 1, 29))).toBe(202402); // leap Feb
    expect(monthKeyFromDate(new Date(2025, 11, 31))).toBe(202512); // year end
    expect(monthKeyFromDate(new Date(2026, 0, 1))).toBe(202601); // year start
    expect(monthKeyFromDate(new Date(2026, 6, 14))).toBe(202607);
  });
});
