import { useState } from 'react';
import { Text } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useMenuNav } from '@/shell/menuNav';
import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { useArchiveBudgetMutation, useGetBudgetsQuery, useUnarchiveBudgetMutation } from '@/budget/data/api';
import { clearActiveBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { DeleteBudgetModal } from './DeleteBudgetModal';
import { t } from './i18n';
import { MenuRow } from './menuRows';
import { refetchBudgets } from '@/state/refetchBudgets';
import { manageBudgetHint } from './settings.logic';
import { s } from './styles';

/** Destructive half of Plan Settings — archive/unarchive + modal delete. */
export function BudgetManageSection({ budgetId }: { budgetId: string }) {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const [archiveBudget] = useArchiveBudgetMutation();
  const [unarchiveBudget] = useUnarchiveBudgetMutation();
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const target = budgets.data?.find((b) => b.id === budgetId) ?? null;

  if (!target) {
    return <Text style={s.hint}>{t('hint.switchFirst')}</Text>;
  }

  const archived = !!target.archived_at;
  const setArchived = (archive: boolean) => {
    setError(null);
    (archive ? archiveBudget({ id: target.id }) : unarchiveBudget({ id: target.id }))
      .unwrap()
      .then(async () => {
        await refetchBudgets(dispatch);
        // Archiving the active budget: the shell's reconcile only picks a new
        // one after the refetched list lands (it skips archived rows).
        if (archive && target.id === activeBudgetId) {
          void dispatch(clearActiveBudget());
        }
        nav.back();
      })
      .catch((err) =>
        setError(apiErrorMessage(err, archive ? t('manage.archiveFailed') : t('manage.unarchiveFailed'))),
      );
  };

  return (
    <>
      <Text style={s.hint}>
        {manageBudgetHint(target.name, archived)}
      </Text>
      <MenuRow
        label={archived ? t('manage.unarchive') : t('manage.archive')}
        onPress={() => setArchived(!archived)}
      />
      <MenuRow label={t('manage.delete')} chevron="✕" onPress={() => setDeleting(true)} />
      {error ? <Text style={s.errorText}>{error}</Text> : null}
      {deleting ? <DeleteBudgetModal target={target} onClose={() => setDeleting(false)} /> : null}
    </>
  );
}
