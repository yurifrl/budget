import { Text } from 'react-native';

import { useMenuNav } from '@/shell/menuNav';
import { useAppSelector } from '@/state/hooks';

import { useGetBudgetsQuery } from '@/budget/data/api';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { selectActiveBudgetId } from '@/state/ui';
import { MenuRow } from './menuRows';
import { archivedBudgetLabel, splitBudgets } from './settings.logic';
import { s } from './styles';

/** Budget switcher list — every row opens the per-budget menu (EDIT BUDGET). */
export function OpenBudgetPane() {
  const { formatDate } = useMoneyFormat();
  const nav = useMenuNav();
  const activeBudgetId = useAppSelector((s) =>
    selectActiveBudgetId(s),
  );
  const budgets = useGetBudgetsQuery();
  const { active, archived } = splitBudgets(budgets.data);
  return (
    <>
      {active.map((b) => (
        <MenuRow
          key={b.id}
          label={b.name}
          active={b.id === activeBudgetId}
          onPress={() => nav.openBudget(b.id)}
        />
      ))}
      {!active.length ? <Text style={s.hint}>No budgets yet.</Text> : null}
      {archived.length ? (
        <>
          <Text style={s.sectionLabel}>ARCHIVED</Text>
          {archived.map((b) => (
            <MenuRow
              key={b.id}
              label={archivedBudgetLabel(b, formatDate)}
              onPress={() => nav.openBudget(b.id)}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
