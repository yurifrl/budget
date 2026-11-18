/**
 * Budget instance thunks — switching and restoring the active Budget.
 *
 * The active `budget_id` persists through the injected `KVStore` (resolved
 * from the DI container via the thunk `extra` argument) so the chosen budget
 * survives app restarts. No api reset is needed on switch: every budget-scoped
 * cache entry is keyed by budget id, so a switch simply reads/fetches the
 * other budget's entries.
 */

import { createAsyncThunk } from '@reduxjs/toolkit';

import type { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';

import { selectActiveBudgetId, setActiveBudget, type BudgetUiRootState } from './ui';

/** KVStore key holding the persisted active budget id. */
export const ACTIVE_BUDGET_STORAGE_KEY = 'budget.activeBudgetId';

type ThunkConfig = { extra: unknown };

/** Switch the active Budget and persist the choice. */
export const switchBudget = createAsyncThunk<void, string, ThunkConfig>(
  'budgetUi/switchBudget',
  async (budgetId, { dispatch, extra }) => {
    dispatch(setActiveBudget(budgetId));
    const storage = (extra as Container).resolve(Tokens.Storage);
    await storage.set(ACTIVE_BUDGET_STORAGE_KEY, budgetId);
  },
);

/**
 * Clear the active Budget selection (archive/delete of the active budget):
 * nulls the redux id, so the shell leaves for the home page (shellGate),
 * and drops the persisted key so a stale id never resurrects on relaunch.
 */
export const clearActiveBudget = createAsyncThunk<void, void, ThunkConfig>(
  'budgetUi/clearActiveBudget',
  async (_, { dispatch, extra }) => {
    dispatch(setActiveBudget(null));
    const storage = (extra as Container).resolve(Tokens.Storage);
    await storage.remove(ACTIVE_BUDGET_STORAGE_KEY);
  },
);

/**
 * Restore the persisted active Budget when the budget shell mounts (reload or
 * deep link inside a budget). Returns the stored id, or null when nothing was
 * persisted: the shell then sends the person to the home page to pick one.
 */
export const restoreActiveBudget = createAsyncThunk<string | null, void, ThunkConfig>(
  'budgetUi/restoreActiveBudget',
  async (_, { dispatch, getState, extra }) => {
    const storage = (extra as Container).resolve(Tokens.Storage);
    const stored = await storage.get<string | null>(ACTIVE_BUDGET_STORAGE_KEY, null);
    // A budget opened from the home page in this session wins over the
    // persisted one (the shell mounts, and restores, after that choice).
    const current = selectActiveBudgetId(getState() as BudgetUiRootState);
    if (stored && !current) dispatch(setActiveBudget(stored));
    return stored;
  },
);
