/**
 * Auto-assign panel (task syscd-app-glm) — opened from the plan header's
 * "Assign ›" button. Lists the domain auto-assign strategies computed over the
 * current month's budget snapshot; tapping one persists that strategy's rows
 * (absolute assigned cents) for every category it would change.
 */

import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useAppDispatch } from '@/state/hooks';

import { useApplyAutoAssignMutation } from '@/budget/data/api';
import {
  AVERAGE_STRATEGIES,
  buildAutoAssignSnapshot,
  buildAutoAssignStrategies,
  type AutoAssignStrategy,
  type AutoAssignStrategyKey,
} from '@/domain/auto-assign';
import { makeAutoAssignEdit, newPlanEdit } from '@/state/planEdits';
import { recordPlanEdit } from '@/state/ui';
import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Budget, Cents, MonthKey } from '@/domain/types';
import { OverlaySheet, SheetItem } from '@/ui/bits';
import { colors } from '@/ui/theme';

const STRATEGY_LABELS: Record<AutoAssignStrategyKey, string> = {
  underfunded: 'Underfunded',
  assignedLastMonth: 'Assigned Last Month',
  spentLastMonth: 'Spent Last Month',
  averageAssigned: 'Average Assigned (6mo)',
  averageSpent: 'Average Spent (6mo)',
  reduceOverfunding: 'Reduce Overfunding',
  resetAvailable: 'Reset Available to $0',
  resetAssigned: 'Reset Assigned to $0',
};

/** One-line effect summary under the strategy label. */
function strategySub(s: AutoAssignStrategy, formatMoney: (cents: Cents) => string): string {
  if (s.rows.length === 0) return 'nothing to change';
  const total = s.totalCents > 0 ? `+${formatMoney(s.totalCents)}` : formatMoney(s.totalCents);
  const avg =
    AVERAGE_STRATEGIES.includes(s.key) && s.monthsUsed.length > 0
      ? ` · ${s.monthsUsed.length}-mo avg`
      : '';
  return `${s.rows.length} ${s.rows.length === 1 ? 'category' : 'categories'} · ${total}${avg}`;
}

export function AutoAssignPanel({
  visible,
  onClose,
  budget,
  budgetId,
  month,
  rtaCents,
}: {
  visible: boolean;
  onClose: () => void;
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  rtaCents: Cents;
}) {
  return (
    <OverlaySheet visible={visible} onClose={onClose} title="AUTO-ASSIGN">
      <AutoAssignList
        budget={budget}
        budgetId={budgetId}
        month={month}
        rtaCents={rtaCents}
        onDone={onClose}
      />
    </OverlaySheet>
  );
}

/**
 * Strategy list body shared by the AutoAssignPanel overlay and the plan
 * header's Assign dropdown Auto tab (syscd-app-4rr). `onDone` runs after a
 * strategy persists (closes the host surface).
 */
export function AutoAssignList({
  budget,
  budgetId,
  month,
  rtaCents,
  onDone,
}: {
  budget: Budget;
  budgetId: string;
  month: MonthKey;
  rtaCents: Cents;
  onDone: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const [apply] = useApplyAutoAssignMutation();
  const dispatch = useAppDispatch();
  const [applyingKey, setApplyingKey] = useState<AutoAssignStrategyKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const strategies = useMemo(
    () => buildAutoAssignStrategies(buildAutoAssignSnapshot(budget, month)),
    [budget, month],
  );

  async function run(s: AutoAssignStrategy) {
    if (s.rows.length === 0 || applyingKey !== null) return;
    setApplyingKey(s.key);
    setError(null);
    try {
      await apply({ budgetId, month, rows: s.rows }).unwrap();
      // Snapshot over the pre-mutation `budget` prop; persisting already succeeded.
      const draft = makeAutoAssignEdit(budget, budgetId, month, s.rows, STRATEGY_LABELS[s.key]);
      if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
      onDone();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to apply auto-assign'));
      setApplyingKey(null);
    }
  }

  return (
    <>
      <View style={styles.rtaLine}>
        <Text style={styles.rtaSub}>Ready to Assign</Text>
        <Text style={styles.rtaAmount}>{formatMoney(rtaCents)}</Text>
      </View>
      <ScrollView style={styles.list} contentContainerStyle={styles.listContent}>
        {strategies.map((s) => (
          <SheetItem
            key={s.key}
            label={STRATEGY_LABELS[s.key]}
            sub={strategySub(s, formatMoney)}
            active={applyingKey === s.key}
            onPress={s.rows.length === 0 || applyingKey !== null ? undefined : () => run(s)}
          />
        ))}
      </ScrollView>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </>
  );
}

const styles = StyleSheet.create({
  rtaLine: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 8,
  },
  rtaSub: { color: colors.rtaSub, fontSize: 12 },
  rtaAmount: { color: colors.greenPillFg, fontSize: 16, fontWeight: '800' },
  list: { maxHeight: 420 },
  listContent: { gap: 2 },
  error: { color: colors.redFg, fontSize: 12, marginTop: 8 },
});
