import { useState } from 'react';
import { Text } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/menuNav';
import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { useFreshStartBudgetMutation, useGetBudgetsQuery } from '@/budget/data/api';
import { switchBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { MenuRow } from './menuRows';
import { refetchBudgets } from '@/state/refetchBudgets';
import { t } from './i18n';
import { freshStartHint } from './settings.logic';
import { s } from './styles';

/** Fresh Start (AUTHORED-06) — archive the current budget, start a new one. */
export function FreshStartPane() {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const [freshStart] = useFreshStartBudgetMutation();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = budgets.data?.find((b) => b.id === activeBudgetId);
  const start = () => {
    if (!activeBudgetId) return;
    setError(null);
    freshStart({ budgetId: activeBudgetId })
      .unwrap()
      .then(async ({ created }) => {
        await refetchBudgets(dispatch);
        dispatch(switchBudget(created.id));
        nav.close();
      })
      .catch((err) => setError(apiErrorMessage(err, t('fresh.failed'))));
  };
  return (
    <>
      <Text style={s.hint}>
        {freshStartHint(current)}
      </Text>
      {confirm ? (
        <MenuRow label={t('fresh.confirm')} emphasized onPress={start} />
      ) : null}
      <MenuRow label={confirm ? tCommon('cancel') : t('fresh.start')} emphasized={!confirm} onPress={() => setConfirm(!confirm)} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
    </>
  );
}
