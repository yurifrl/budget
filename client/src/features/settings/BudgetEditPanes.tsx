import { Text } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { useMenuNav } from '@/shell/menuNav';
import { useAppDispatch, useAppSelector } from '@/state/hooks';

import { useGetBudgetsQuery } from '@/budget/data/api';
import { switchBudget } from '@/state/thunks';
import { selectActiveBudgetId } from '@/state/ui';
import { t } from './i18n';
import { MenuRow } from './menuRows';
import { PlanSettingsPane } from './PlanSettingsPane';
import { s } from './styles';

/** Per-budget menu (Open Budget rows): Open the budget, or jump to Edit. */
export function BudgetEditMenuPane() {
  const dispatch = useAppDispatch();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const target = budgets.data?.find((b) => b.id === nav.editingBudgetId) ?? null;
  if (!target) return <Text style={s.hint}>{t('edit.unavailable')}</Text>;
  const open = () => {
    void dispatch(switchBudget(target.id));
    nav.close();
  };
  return (
    <>
      <Text style={s.sectionLabel}>{target.name}</Text>
      {target.id === activeBudgetId ? (
        <MenuRow label={t('edit.current')} active onPress={open} />
      ) : (
        <MenuRow label={t('edit.open')} emphasized onPress={open} />
      )}
      <MenuRow label={tCommon('edit')} onPress={() => nav.open('budget-settings')} />
    </>
  );
}

/**
 * Plan Settings for the EDIT BUDGET menu target: renders the same
 * PlanSettingsPane, but bound to the menu's budget — clicking Edit on a
 * non-active budget must configure that budget, not the active one.
 */
export function BudgetEditSettingsPane() {
  const nav = useMenuNav();
  const budgets = useGetBudgetsQuery();
  const target = budgets.data?.find((b) => b.id === nav.editingBudgetId) ?? null;
  if (!target) return <Text style={s.hint}>{t('edit.unavailable')}</Text>;
  return <PlanSettingsPane budgetId={target.id} key={target.id} />;
}
