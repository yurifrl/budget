/**
 * Per-budget settings persistence: the ONE place that loads and saves the
 * settings blob for the active budget (key `budget.settings.<budgetId>`,
 * format in data/settingsBlob.ts).
 *
 * - Hydrate: every `setActiveBudget(id)` loads that budget's blob and
 *   dispatches `budgetSettingsLoaded` (ignored if the user switched again
 *   before the load returned).
 * - Persist: the user-facing settings actions (format prefs, a flag label,
 *   the three display toggles) are written as a sectioned patch. Writes are
 *   serialised so a burst (typing a flag label) lands in order.
 *
 * Editing a NON-active budget's format (Plan Settings opened from Open
 * Budget) does not touch this state; that pane writes the blob directly.
 */

import { createListenerMiddleware, isAnyOf, type UnknownAction } from '@reduxjs/toolkit';

import type { KVStore } from '@/platform/storage/types';

import { loadBudgetSettings, saveBudgetSettingsPatch, type BudgetSettingsBlob } from '../data/settingsBlob';
import {
  BUDGET_UI_KEY,
  budgetSettingsLoaded,
  setActiveBudget,
  setFlagLabel,
  setFmtPrefs,
  setShowClosedAccounts,
  setShowHiddenCategories,
  setShowProgressBars,
  type BudgetUiRootState,
} from './ui';

const persisted = isAnyOf(setFmtPrefs, setFlagLabel, setShowProgressBars, setShowHiddenCategories, setShowClosedAccounts);

/**
 * The blob patch a persisted action writes, read from the state AFTER the
 * action (null for anything else). Same patches the Settings panes used to
 * write themselves: the fmt delta, the whole flag-label map, one display key.
 */
export function settingsPatchFor(action: UnknownAction, state: BudgetUiRootState): BudgetSettingsBlob | null {
  const ui = state[BUDGET_UI_KEY];
  if (setFmtPrefs.match(action)) return { fmt: action.payload };
  if (setFlagLabel.match(action)) return { flagLabels: ui.flagLabels };
  if (setShowProgressBars.match(action)) return { display: { progressBars: action.payload } };
  if (setShowHiddenCategories.match(action)) return { display: { hiddenCategories: action.payload } };
  if (setShowClosedAccounts.match(action)) return { display: { closedAccounts: action.payload } };
  return null;
}

/** Listener middleware wiring hydration + persistence to `storage`. */
export function createBudgetSettingsListener(storage: () => KVStore) {
  const listener = createListenerMiddleware();
  let writes: Promise<void> = Promise.resolve();

  listener.startListening({
    actionCreator: setActiveBudget,
    effect: async (action, api) => {
      const budgetId = action.payload;
      if (!budgetId) return;
      const blob = await loadBudgetSettings(storage(), budgetId);
      if ((api.getState() as BudgetUiRootState)[BUDGET_UI_KEY].activeBudgetId !== budgetId) return;
      api.dispatch(budgetSettingsLoaded(blob));
    },
  });

  listener.startListening({
    matcher: persisted,
    effect: (action, api) => {
      const state = api.getState() as BudgetUiRootState;
      const budgetId = state[BUDGET_UI_KEY].activeBudgetId;
      const patch = settingsPatchFor(action, state);
      if (!budgetId || !patch) return;
      writes = writes.then(() => saveBudgetSettingsPatch(storage(), budgetId, patch)).catch(() => {});
    },
  });

  return listener;
}
