import { useState } from 'react';
import { Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import { useAppDispatch } from '@/state/hooks';

import { useSetMonthNoteMutation } from '@/budget/data/api';
import { assignedInFutureMonths, costToBeMe } from '@/domain/engine';
import { formatMonth, nextMonth } from '@/domain/format';
import { noteDraft, syncNoteDraft } from '@/domain/noteDraft';
import { monthTotalsForPerson, type ActivityMap, type PersonFilter } from '@/domain/people';
import type { Budget, MonthKey } from '@/domain/types';
import type { BudgetMonth } from '@/domain/zeroSum';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { setActiveMonth } from '@/state/ui';
import { colors } from '@/ui/theme';
import { styles } from './styles';
import { t } from './inspector/i18n';

/** Month summary card (task 5.7) — the inspector's no-selection state. */
export function MonthSummary({
  budget,
  budgetId,
  bm,
  month,
  activityMap,
  person,
  scopeLabel,
}: {
  budget: Budget;
  budgetId: string;
  /** The engine's figures for `month`. */
  bm: BudgetMonth;
  month: MonthKey;
  /** Per-person activity (null = household). */
  activityMap: ActivityMap | null;
  person: PersonFilter;
  /** "Ana’s categories" / "Shared categories"; null = Everyone. */
  scopeLabel: string | null;
}) {
  const { formatMoney } = useMoneyFormat();
  const dispatch = useAppDispatch();
  const [setMonthNote] = useSetMonthNoteMutation();
  // The draft follows the stored note when that changes (budget switch, notes
  // arriving after mount): budget-xd6.
  const savedNote = budget.monthNotes?.[month] ?? '';
  const [noteState, setNoteState] = useState(() => noteDraft(savedNote));
  const synced = syncNoteDraft(noteState, savedNote);
  if (synced !== noteState) setNoteState(synced);
  const note = synced.draft;
  const setNote = (draft: string) => setNoteState((st) => ({ ...st, draft }));
  // Assigned/Available sum the categories the Plan shows for the selection;
  // Activity is the person's (their accounts). Everyone = the household sums.
  const totals = monthTotalsForPerson(bm, budget.categories, person, activityMap);
  const activity = totals.activity;
  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Text style={styles.summaryTitle}>{formatMonth(month)}</Text>
      {scopeLabel ? <Text style={styles.summaryScope}>{scopeLabel}</Text> : null}
      <View style={styles.summaryCard}>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{t('month.cost')}</Text>
          <Text style={[styles.kvValue, { fontWeight: '700' }]}>{formatMoney(costToBeMe(budget, month))}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{t('month.assigned')}</Text>
          <Text style={styles.kvValue}>{formatMoney(totals.assigned)}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{t('month.activity')}</Text>
          <Text style={styles.kvValue}>{formatMoney(activity)}</Text>
        </View>
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{t('month.available')}</Text>
          <Text style={styles.kvValue}>{formatMoney(totals.available)}</Text>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('month.future')}
        onPress={() => dispatch(setActiveMonth(nextMonth(month)))}
        style={styles.summaryCard}
      >
        <View style={styles.kvRow}>
          <Text style={styles.kvLabel}>{t('month.future')}</Text>
          <Text style={[styles.kvValue, { color: colors.indigo }]}>
            {formatMoney(assignedInFutureMonths(budget, month))}
          </Text>
        </View>
      </Pressable>
      <View style={styles.summaryCard}>
        <Text style={[styles.kvValue, { fontWeight: '700', marginBottom: 6 }]}>{t('month.noteTitle')}</Text>
        <TextInput
          value={note}
          onChangeText={setNote}
          onBlur={() => {
            if (note !== (budget.monthNotes?.[month] ?? '')) {
              void setMonthNote({ budgetId, month, note });
            }
          }}
          multiline
          placeholder={t('month.notePlaceholder')}
          placeholderTextColor={colors.faint}
          style={styles.noteInput}
          accessibilityLabel={t('month.noteTitle')}
        />
      </View>
    </ScrollView>
  );
}
