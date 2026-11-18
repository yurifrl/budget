import { Text } from 'react-native';

import { useMenuNav } from '@/shell/SettingsMenu';
import { useAppDispatch, useAppSelector } from '@/store/hooks';

import { useGetBudgetsQuery } from '../../data/api';
import { switchBudget } from '../../state/thunks';
import { selectActiveBudgetId } from '../../state/ui';
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
  if (!target) return <Text style={s.hint}>Budget unavailable.</Text>;
  const open = () => {
    void dispatch(switchBudget(target.id));
    nav.close();
  };
  return (
    <>
      <Text style={s.sectionLabel}>{target.name}</Text>
      {target.id === activeBudgetId ? (
        <MenuRow label="Current Budget" active onPress={open} />
      ) : (
        <MenuRow label="Open" emphasized onPress={open} />
      )}
      <MenuRow label="Edit" onPress={() => nav.open('budget-settings')} />
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
  if (!target) return <Text style={s.hint}>Budget unavailable.</Text>;
  return <PlanSettingsPane budgetId={target.id} key={target.id} />;
}
