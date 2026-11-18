/**
 * Assign dropdown (syscd-app-4rr) — the plan header Assign control becomes an
 * anchored dropdown with two tabs: '⚡ Auto' (the existing auto-assign strategy
 * list, shared with AutoAssignPanel) and 'Manually' (YNAB layout: Assign
 * amount + searchable To select over Ready to Assign + categories, reusing the
 * syscd-app-aey ToDropdown pattern). A manual assign persists the single
 * absolute assignment via applyAssignmentUpdates and records an undo edit.
 */

import { useCallback, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useAppDispatch } from '@/store/hooks';

import { useApplyAssignmentUpdatesMutation } from '../data/api';
import type { Budget, Cents, MonthKey } from '../domain/types';
import { useBudgetMonth } from '../model/useBudgetMonth';
import { useMoneyFormat } from '../model/useDisplayPrefs';
import { makeAssignEdit, newPlanEdit } from '../state/planEdits';
import { recordPlanEdit } from '../state/ui';
import { AutoAssignList } from './AutoAssignPanel';
import { MoneyInput } from '../ui/bits';
import { useEscapeToClose } from '../ui/escapeToClose';
import { colors, radius } from '../ui/theme';
import { ToDropdown } from './MoveMoneySheet';

export type AssignTab = 'auto' | 'manual';

/** Manually tab body: Assign amount + To select + Cancel/Assign footer. */
function ManualAssign({
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
  const [apply] = useApplyAssignmentUpdatesMutation();
  const dispatch = useAppDispatch();
  const bm = useBudgetMonth(budget, month);
  const [amount, setAmount] = useState<Cents>(0);
  const [to, setTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const canAssign = to !== null && amount !== 0;

  const onAssign = useCallback(() => {
    const cat = to ? budget.categories.find((c) => c.id === to) : null;
    if (!cat || amount === 0) return;
    setError(null);
    // Spec: the typed amount IS the absolute assigned value for the month.
    const next = amount;
    apply({ budgetId, month, updates: [{ categoryId: cat.id, assignedCents: next }] })
      .unwrap()
      .then(() => {
        const draft = makeAssignEdit(budget, budgetId, month, cat.id, next, { formatMoney });
        if (draft) dispatch(recordPlanEdit(newPlanEdit(draft)));
        onDone();
      })
      .catch((err) => setError(apiErrorMessage(err, 'failed to assign')));
  }, [apply, budget, budgetId, dispatch, month, onDone, to, amount, formatMoney]);

  return (
    <View style={styles.manualBody}>
      <View style={styles.manualRow}>
        <Text style={styles.manualLabel}>Assign:</Text>
        <MoneyInput cents={amount} onCommit={setAmount} quickMath style={styles.manualAmount} />
      </View>
      <View style={styles.manualRow}>
        <Text style={styles.manualLabel}>To:</Text>
        <View style={styles.manualToCell}>
          <ToDropdown
            categories={budget.categories}
            groups={budget.groups}
            fromId={null}
            selectedTo={to}
            readyToAssign={rtaCents}
            bm={bm}
            onPick={setTo}
          />
        </View>
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footer}>
        <Pressable style={styles.footerBtn} onPress={onDone} accessibilityRole="button" accessibilityLabel="Cancel assign">
          <Text style={styles.footerBtnText}>Cancel</Text>
        </Pressable>
        <Pressable
          style={[styles.footerAssign, !canAssign && styles.footerBtnDisabled]}
          onPress={canAssign ? onAssign : undefined}
          disabled={!canAssign}
          accessibilityRole="button"
          accessibilityLabel="Assign amount">
          <Text style={[styles.footerAssignText, !canAssign && styles.footerBtnDisabled]}>Assign</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Tabbed Assign dropdown body — hosted inside the caller's anchored card. */
export function AssignDropdownBody({
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
  const [tab, setTab] = useState<AssignTab>('auto');
  // Esc closes the dropdown (budget-ipa), after an open To select or the
  // amount editor had the chance to claim it.
  useEscapeToClose(onDone);
  return (
    <>
      <View style={styles.tabs}>
        <Pressable
          style={[styles.tab, tab === 'auto' && styles.tabActive]}
          onPress={() => setTab('auto')}
          accessibilityRole="button"
          accessibilityLabel="Auto-assign strategies tab">
          <Text style={[styles.tabText, tab === 'auto' && styles.tabTextActive]}>⚡ Auto</Text>
        </Pressable>
        <Pressable
          style={[styles.tab, tab === 'manual' && styles.tabActive]}
          onPress={() => setTab('manual')}
          accessibilityRole="button"
          accessibilityLabel="Manual assign tab">
          <Text style={[styles.tabText, tab === 'manual' && styles.tabTextActive]}>Manually</Text>
        </Pressable>
      </View>
      {tab === 'auto' ? (
        <AutoAssignList
          budget={budget}
          budgetId={budgetId}
          month={month}
          rtaCents={rtaCents}
          onDone={onDone}
        />
      ) : (
        <ManualAssign
          budget={budget}
          budgetId={budgetId}
          month={month}
          rtaCents={rtaCents}
          onDone={onDone}
        />
      )}
    </>
  );
}

const styles = StyleSheet.create({
  tabs: {
    flexDirection: 'row',
    gap: 4,
    paddingHorizontal: 8,
    paddingTop: 8,
  },
  tab: {
    paddingVertical: 6,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
  },
  tabActive: { backgroundColor: colors.card2 },
  tabText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  tabTextActive: { color: colors.indigo2 },
  manualBody: { padding: 10, gap: 8 },
  manualRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  manualLabel: { color: colors.muted, fontSize: 13, width: 64, textAlign: 'right' },
  manualAmount: { minWidth: 110 },
  manualToCell: { flex: 1 },
  error: { color: colors.redFg, fontSize: 12 },
  footer: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
    marginTop: 4,
  },
  footerBtn: { paddingVertical: 7, paddingHorizontal: 14 },
  footerBtnText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  footerAssign: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 7,
    paddingHorizontal: 16,
  },
  footerAssignText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  footerBtnDisabled: { opacity: 0.45 },
});
