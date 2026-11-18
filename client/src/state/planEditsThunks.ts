/**
 * Plan-edit undo/redo thunks (syscd-app-ijn).
 *
 * Every recorded edit carries the touched categories' absolute assigned cents
 * before and after, so undo/redo/revert simply re-apply the corresponding side
 * through the shared `/assignments/batch` endpoint (`applyAssignmentUpdates`)
 * and then move the entry between the past/future stacks. The forward path
 * (setAssigned / applyAssignmentUpdates / applyAutoAssign) is untouched: its
 * call sites only dispatch `recordPlanEdit` after a successful write.
 */

import { createAsyncThunk, type ThunkDispatch, type UnknownAction } from '@reduxjs/toolkit';

import { budgetApi } from '@/budget/data/api';
import type { PlanEditEntry } from './planEdits';
import { BUDGET_UI_KEY, planEditReapplied, planEditUndone, planEditReverted, type BudgetUiRootState } from './ui';

type ThunkConfig = { extra: unknown };

/** Re-apply one recorded edit's `before`/`after` absolute values for its month. */
async function reapplyPlanEditUpdates(
  dispatch: ThunkDispatch<unknown, unknown, UnknownAction>,
  entry: PlanEditEntry,
  side: 'before' | 'after',
): Promise<void> {
  await dispatch(
    budgetApi.endpoints.applyAssignmentUpdates.initiate({
      budgetId: entry.budgetId,
      month: entry.month,
      updates: entry.updates.map((u) => ({ categoryId: u.categoryId, assignedCents: u[side] })),
    }),
  ).unwrap();
}

/** Undo the newest applied edit; resolves null when history is empty. Rejects (state intact) when the write fails. */
export const undoPlanEdit = createAsyncThunk<PlanEditEntry | null, void, ThunkConfig>(
  'budgetUi/undoPlanEdit',
  async (_, { dispatch, getState }) => {
    const state = getState() as BudgetUiRootState;
    const past = state[BUDGET_UI_KEY].planEdits.past;
    const entry = past[past.length - 1];
    if (!entry) return null;
    await reapplyPlanEditUpdates(dispatch, entry, 'before');
    dispatch(planEditUndone());
    return entry;
  },
);

/** Redo the newest undone edit; resolves null when nothing is redoable. */
export const redoPlanEdit = createAsyncThunk<PlanEditEntry | null, void, ThunkConfig>(
  'budgetUi/redoPlanEdit',
  async (_, { dispatch, getState }) => {
    const state = getState() as BudgetUiRootState;
    const future = state[BUDGET_UI_KEY].planEdits.future;
    const entry = future[future.length - 1];
    if (!entry) return null;
    await reapplyPlanEditUpdates(dispatch, entry, 'after');
    dispatch(planEditReapplied());
    return entry;
  },
);

/** Revert one specific move from the Recent Moves list; resolves null when the id is gone. */
export const revertPlanEdit = createAsyncThunk<PlanEditEntry | null, string, ThunkConfig>(
  'budgetUi/revertPlanEdit',
  async (id, { dispatch, getState }) => {
    const state = getState() as BudgetUiRootState;
    const past = state[BUDGET_UI_KEY].planEdits.past;
    const entry = past.find((e) => e.id === id);
    if (!entry) return null;
    await reapplyPlanEditUpdates(dispatch, entry, 'before');
    dispatch(planEditReverted(id));
    return entry;
  },
);
