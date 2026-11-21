/**
 * useHome: the home page's data and its two ways into a budget. Thin on
 * purpose: the rules are in home.logic.ts.
 *
 * Entering a budget is always the same three steps, in this order: the
 * Budgets list contains it, the active budget is switched (and persisted, so
 * a reload inside the budget stays there), then the shell route is pushed.
 * The shell's gate sends anyone whose active budget is not in the list back
 * here, so a new budget is refetched into the list before the switch
 * (budget-fwf).
 */
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';

import { useCreateBudgetMutation, useGetBudgetsQuery } from '@/budget/data/api';
import { useMe } from '@/features/profile';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppDispatch } from '@/state/hooks';
import { refetchBudgets } from '@/state/refetchBudgets';
import { switchBudget } from '@/state/thunks';
import { useMedia } from '@/ui/media';

import { t } from './i18n';
import { budgetEntryRoute, checkBudgetName, homeGreeting, homeSections, homeView } from './home.logic';

export function useHome() {
  const router = useRouter();
  const dispatch = useAppDispatch();
  const media = useMedia();
  const isPhone = media['max-md'];
  const budgets = useGetBudgetsQuery();
  const { me } = useMe();
  const [createBudget] = useCreateBudgetMutation();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const view = homeView({ data: budgets.data, isError: budgets.isError });
  const sections = useMemo(() => homeSections(budgets.data), [budgets.data]);

  const open = useCallback(
    async (budgetId: string) => {
      await dispatch(switchBudget(budgetId));
      router.push(budgetEntryRoute(isPhone));
    },
    [dispatch, router, isPhone],
  );

  /** Create a budget and land inside it. Resolves false when nothing was created. */
  const create = useCallback(
    async (rawName: string): Promise<boolean> => {
      if (creating) return false;
      const check = checkBudgetName(rawName);
      if (!check.ok) {
        setCreateError(check.error);
        return false;
      }
      setCreating(true);
      setCreateError(null);
      try {
        const created = await createBudget({ name: check.name }).unwrap();
        await refetchBudgets(dispatch);
        await open(created.id);
        return true;
      } catch (err) {
        setCreateError(apiErrorMessage(err, t('create.failed')));
        return false;
      } finally {
        setCreating(false);
      }
    },
    [creating, createBudget, dispatch, open],
  );

  return {
    view,
    sections,
    greeting: homeGreeting(me, view),
    /** Wide windows get the two-pane frame (same rule as the landing page). */
    split: media.lg,
    refetch: budgets.refetch,
    open,
    create,
    creating,
    createError,
    clearCreateError: useCallback(() => setCreateError(null), []),
  };
}
