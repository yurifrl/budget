/** Plan-edit history: record inline assigned edits, undo / redo, and the Recent Moves list. */
import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { useSetAssignedMutation } from '@/budget/data/api';
import type { Budget, Cents, MonthKey } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { makeAssignEdit, newPlanEdit, selectPlanEdits, selectRecentPlanEdits } from '@/state/planEdits';
import { redoPlanEdit, revertPlanEdit, undoPlanEdit } from '@/state/planEditsThunks';
import { recordPlanEdit } from '@/state/ui';

export function usePlanUndo(budget: Budget | undefined, budgetId: string | null, month: MonthKey) {
  const { formatMoney } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const [setAssigned] = useSetAssignedMutation();
  const planEdits = useAppSelector((s) => selectPlanEdits(s));
  const recentMoves = useAppSelector((s) => selectRecentPlanEdits(s));

  /** Persist one inline assigned edit and record its undo snapshot on success. */
  const recordAssigned = (categoryId: string, next: Cents) => {
    if (!budget || !budgetId) return;
    void setAssigned({ budgetId, month, categoryId, assignedCents: next })
      .unwrap()
      .then(() => {
        const draft = makeAssignEdit(budget, budgetId, month, categoryId, next, { formatMoney });
        if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
      })
      .catch(() => undefined);
  };

  return {
    canUndo: planEdits.past.length > 0,
    canRedo: planEdits.future.length > 0,
    recentMoves,
    recordAssigned,
    undo: () => void dispatch(undoPlanEdit()),
    redo: () => void dispatch(redoPlanEdit()),
    revert: (editId: string) => void dispatch(revertPlanEdit(editId)),
  };
}

export type PlanUndo = ReturnType<typeof usePlanUndo>;
