/**
 * budgetUi slice — ephemeral UI / session state for the Budget app.
 *
 * Holds the active month, the active Budget instance (`budget_id`), the
 * selected category (drives the inspector), the Plan filter chips, and the
 * progress-bar toggle. Server data lives in `budgetApi`; derived values come
 * from the domain engine — neither is ever stored here (design D3).
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { PERSON_ALL, type PersonFilter } from '../domain/people';
import type { MonthKey } from '../domain/types';
import {
  initialPlanEdits,
  movePlanEditRevertToFuture,
  movePlanEditToFuture,
  movePlanEditToPast,
  pushPlanEdit,
  type PlanEditEntry,
  type PlanEditsState,
} from './planEdits';

export const BUDGET_UI_KEY = 'budgetUi';

/** Plan screen filter chips (mirrors the mock: All / Underfunded / …). */
export type PlanFilter = 'all' | 'underfunded' | 'overfunded' | 'money-available' | 'snoozed';

export interface BudgetUiState {
  /** The active Budget instance; null until restored/selected. */
  activeBudgetId: string | null;
  /** Month in focus on Plan (YYYYMM). */
  activeMonth: MonthKey;
  /** Category selected in the budget table (drives the inspector). */
  selectedCategoryId: string | null;
  planFilter: PlanFilter;
  /** Plan "by person" Activity filter: 'all' | 'shared' | member user id (see domain/people.ts). */
  personFilter: PersonFilter;
  showProgressBars: boolean;
  /** Whether the Hidden Categories aggregate row renders on Plan. */
  showHiddenCategories: boolean;
  /** Whether the rail renders the CLOSED accounts group (off = YNAB default). */
  showClosedAccounts: boolean;
  /** Session-scoped undo/redo history for Plan assignment edits (syscd-app-ijn). */
  planEdits: PlanEditsState;
}

/** Month key for a Date: 2026-06-05 -> 202606. */
export function monthKeyFromDate(date: Date): MonthKey {
  return date.getFullYear() * 100 + (date.getMonth() + 1);
}

/** The current real-world month as a MonthKey (e.g. 202606). */
export function currentMonthKey(): MonthKey {
  return monthKeyFromDate(new Date());
}

const initialState: BudgetUiState = {
  activeBudgetId: null,
  activeMonth: currentMonthKey(),
  selectedCategoryId: null,
  planFilter: 'all',
  personFilter: PERSON_ALL,
  showProgressBars: true,
  showHiddenCategories: true,
  showClosedAccounts: false,
  planEdits: initialPlanEdits(),
};

const slice = createSlice({
  name: BUDGET_UI_KEY,
  initialState,
  reducers: {
    /** Switch the active Budget instance; selection + edit history are budget-local, so clear them. */
    setActiveBudget(state, action: PayloadAction<string | null>) {
      state.activeBudgetId = action.payload;
      state.selectedCategoryId = null;
      state.personFilter = PERSON_ALL;
      state.planEdits = initialPlanEdits();
    },
    setActiveMonth(state, action: PayloadAction<MonthKey>) {
      state.activeMonth = action.payload;
    },
    selectCategory(state, action: PayloadAction<string | null>) {
      state.selectedCategoryId = action.payload;
    },
    setPlanFilter(state, action: PayloadAction<PlanFilter>) {
      state.planFilter = action.payload;
    },
    setPersonFilter(state, action: PayloadAction<PersonFilter>) {
      state.personFilter = action.payload;
    },
    toggleProgressBars(state) {
      state.showProgressBars = !state.showProgressBars;
    },
    toggleHiddenCategories(state) {
      state.showHiddenCategories = !state.showHiddenCategories;
    },
    /** Absolute display-prefs writes (Settings panel); shell persists after dispatch. */
    setShowProgressBars(state, action: PayloadAction<boolean>) {
      state.showProgressBars = action.payload;
    },
    setShowHiddenCategories(state, action: PayloadAction<boolean>) {
      state.showHiddenCategories = action.payload;
    },
    setShowClosedAccounts(state, action: PayloadAction<boolean>) {
      state.showClosedAccounts = action.payload;
    },
    /** Record a persisted Plan assignment edit (pushes history, truncates redo). */
    recordPlanEdit(state, action: PayloadAction<PlanEditEntry>) {
      pushPlanEdit(state.planEdits, action.payload);
    },
    /** Bookkeeping after an undo request succeeds. */
    planEditUndone(state) {
      movePlanEditToFuture(state.planEdits);
    },
    /** Bookkeeping after a redo / revert request succeeds. */
    planEditReapplied(state) {
      movePlanEditToPast(state.planEdits);
    },
    /** Revert from the Recent Moves list: entry leaves history, becomes redoable. */
    planEditReverted(state, action: PayloadAction<string>) {
      movePlanEditRevertToFuture(state.planEdits, action.payload);
    },
  },
});

export const {
  setActiveBudget,
  setActiveMonth,
  selectCategory,
  setPlanFilter,
  setPersonFilter,
  toggleProgressBars,
  toggleHiddenCategories,
  setShowProgressBars,
  setShowHiddenCategories,
  setShowClosedAccounts,
  recordPlanEdit,
  planEditUndone,
  planEditReapplied,
  planEditReverted,
} = slice.actions;
export const budgetUiReducer = slice.reducer;

/** Root-state shape contributed by this module (for typed selectors). */
export interface BudgetUiRootState {
  [BUDGET_UI_KEY]: BudgetUiState;
}

export const selectBudgetUi = (s: BudgetUiRootState) => s[BUDGET_UI_KEY];
export const selectActiveBudgetId = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].activeBudgetId;
export const selectActiveMonth = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].activeMonth;
export const selectSelectedCategoryId = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].selectedCategoryId;
export const selectPlanFilter = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].planFilter;
export const selectPersonFilter = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].personFilter;
export const selectShowProgressBars = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].showProgressBars;
export const selectShowHiddenCategories = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].showHiddenCategories;
export const selectShowClosedAccounts = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].showClosedAccounts;
