/**
 * budgetUi slice — ephemeral UI / session state for the Budget app.
 *
 * Holds the active month, the active Budget instance (`budget_id`), the
 * selected category (drives the inspector), the Plan filter chips, and the
 * progress-bar toggle. Server data lives in `budgetApi`; derived values come
 * from the domain engine — neither is ever stored here (design D3).
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

import { DEFAULT_FLAG_LABELS, type FlagLabels } from '../domain/flagLabels';
import { DEFAULT_FMT_PREFS, type FmtPrefs } from '../domain/fmtPrefs';
import { PERSON_ALL, type PersonFilter } from '../domain/people';
import type { FlagColor, MonthKey } from '../domain/types';
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
  /** Active budget's money/date format prefs (persisted per budget, see state/budgetSettings). */
  fmt: FmtPrefs;
  /** Active budget's flag labels (persisted per budget). */
  flagLabels: FlagLabels;
  /** Hide Amounts privacy mask (session only, not persisted). */
  moneyMasked: boolean;
}

/** The persisted per-budget settings blob, as far as this slice applies it. */
export interface LoadedBudgetSettings {
  fmt?: Partial<FmtPrefs>;
  flagLabels?: Partial<FlagLabels>;
  display?: { progressBars?: boolean; hiddenCategories?: boolean; closedAccounts?: boolean };
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
  fmt: DEFAULT_FMT_PREFS,
  flagLabels: DEFAULT_FLAG_LABELS,
  moneyMasked: false,
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
    /** Money/date format change for the active budget (persisted by state/budgetSettings). */
    setFmtPrefs(state, action: PayloadAction<Partial<FmtPrefs>>) {
      state.fmt = { ...state.fmt, ...action.payload };
    },
    /** One flag label edit for the active budget (persisted by state/budgetSettings). */
    setFlagLabel(state, action: PayloadAction<{ color: FlagColor; label: string }>) {
      state.flagLabels = { ...state.flagLabels, [action.payload.color]: action.payload.label };
    },
    setMoneyMasked(state, action: PayloadAction<boolean>) {
      state.moneyMasked = action.payload;
    },
    /**
     * Rehydrate from the active budget's settings blob (on every budget
     * switch). Same rules as the old `applyBudgetSettings`: fmt is merged
     * over the current prefs and flag labels over the defaults only when the
     * blob has them; the display toggles fall back to their defaults.
     */
    budgetSettingsLoaded(state, action: PayloadAction<LoadedBudgetSettings>) {
      const blob = action.payload;
      if (blob.fmt) state.fmt = { ...state.fmt, ...blob.fmt };
      if (blob.flagLabels) state.flagLabels = { ...DEFAULT_FLAG_LABELS, ...blob.flagLabels };
      state.showProgressBars = blob.display?.progressBars ?? true;
      state.showHiddenCategories = blob.display?.hiddenCategories ?? true;
      state.showClosedAccounts = blob.display?.closedAccounts ?? false;
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
  setFmtPrefs,
  setFlagLabel,
  setMoneyMasked,
  budgetSettingsLoaded,
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
export const selectFmtPrefs = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].fmt;
export const selectFlagLabels = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].flagLabels;
export const selectMoneyMasked = (s: BudgetUiRootState) => s[BUDGET_UI_KEY].moneyMasked;
