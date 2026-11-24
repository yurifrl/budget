/**
 * ScheduledSection — YNAB-style "Scheduled Transactions" block at the bottom
 * of the register (syscd-app-5nz): a collapsible header listing every
 * future-dated transaction in the current search scope. Rows use the compact
 * scheduled-row design: selection checkbox, flag + attachment glyphs, account
 * name, date, and (for repeat-rule occurrences) a repeat glyph before the
 * right-aligned amount. Selecting the checkbox highlights the row; pressing
 * the row opens the same editor a register row would (inline on desktop, the
 * edit sheet on phone).
 *
 * Derived upcoming card installments (budget-lubt) are read-only rows: dimmed,
 * named by their purchase with the "kk/NN" fraction as a pill that never
 * truncates, a card glyph instead of the flag/attachment ones, and no editor (the
 * server computes them per read; there is no stored row to edit).
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Budget, Transaction } from '@/domain/types';
import { installmentParts } from '@/domain/register';
import { colors, radius } from '@/ui/theme';
import { InlineAddRow } from './register/InlineAddRow';
import { t } from './i18n';
import { displaySystemName } from '@/domain/systemNames';

interface ScheduledSectionProps {
  budget: Budget;
  budgetId: string;
  rows: Transaction[];
  editingTxnId: string | null;
  showWide: boolean;
  onEditWide: (txn: Transaction) => void;
  onEditPhone: (txn: Transaction) => void;
  onCloseEdit: () => void;
  style?: StyleProp<ViewStyle>;
}

export function ScheduledSection({
  budget,
  budgetId,
  rows,
  editingTxnId,
  showWide,
  onEditWide,
  onEditPhone,
  onCloseEdit,
  style,
}: ScheduledSectionProps) {
  const { formatDate, formatMoney } = useMoneyFormat();
  const [open, setOpen] = useState(true);
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());

  if (rows.length === 0) return null;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const openEditor = (txn: Transaction) => {
    if (showWide) onEditWide(txn);
    else onEditPhone(txn);
  };

  return (
    <View accessibilityLabel={t('scheduled.title')} style={style}>
      <Pressable
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
      >
        <Ionicons name="calendar-outline" size={15} color={colors.muted} />
        <Text style={styles.headerText}>{t('scheduled.title')}</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.muted} />
      </Pressable>
      {open
        ? rows.map((txn) => {
            const account = budget.accounts.find((a) => a.id === txn.accountId);
            const installment = installmentParts(txn);
            // A derived installment is read-only: it cannot be selected.
            const checked = !installment && selected.has(txn.id);
            return (
              <View key={txn.id}>
                <Pressable
                  style={[styles.row, checked && styles.rowSelected, installment && !checked && styles.rowInstallment]}
                  accessibilityLabel={
                    installment
                      ? t('scheduled.installmentLabel', { name: displaySystemName(txn.payee) })
                      : t('scheduled.rowLabel', { name: displaySystemName(txn.payee) || account?.name || '' })
                  }
                  onPress={installment ? undefined : () => openEditor(txn)}
                >
                  {installment ? (
                    // Same footprint as the checkbox so the columns stay aligned.
                    <View style={styles.checkHit}>
                      <View style={styles.boxSpacer} />
                    </View>
                  ) : (
                    <Pressable
                      style={styles.checkHit}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked }}
                      accessibilityLabel={t('scheduled.selectLabel', { name: displaySystemName(txn.payee) || account?.name || '' })}
                      onPress={() => toggle(txn.id)}
                    >
                      <View style={[styles.box, checked && styles.boxChecked]}>
                        {checked ? (
                          <Ionicons name="checkmark" size={13} color={colors.white} />
                        ) : null}
                      </View>
                    </Pressable>
                  )}
                  {installment ? (
                    // In place of the flag/attachment glyphs (a placeholder has neither):
                    // keeps the purchase name readable at phone width.
                    <Ionicons name="card-outline" size={15} color={checked ? colors.white : colors.faint} />
                  ) : (
                    <>
                      <Ionicons name="bookmark-outline" size={15} color={colors.faint} />
                      <Ionicons name="image-outline" size={15} color={colors.faint} />
                    </>
                  )}
                  {installment && !showWide ? (
                    // Phone: the purchase name gets the whole line; fraction and
                    // date sit beneath it so neither crushes the name.
                    <View style={styles.stack}>
                      <Text style={[styles.stackName, checked && styles.textOn]} numberOfLines={1}>
                        {installment.name}
                      </Text>
                      <View style={styles.stackMeta}>
                        <Text style={[styles.fraction, checked && styles.fractionOn]} numberOfLines={1}>
                          {installment.fraction}
                        </Text>
                        <Text style={[styles.stackDate, checked && styles.textOn]}>{formatDate(txn.date)}</Text>
                      </View>
                    </View>
                  ) : (
                    <>
                      <Text
                        style={[styles.name, checked && styles.textOn]}
                        numberOfLines={1}
                      >
                        {installment ? installment.name : (account?.name ?? displaySystemName(txn.payee ?? ''))}
                      </Text>
                      {installment ? (
                        <Text style={[styles.fraction, checked && styles.fractionOn]} numberOfLines={1}>
                          {installment.fraction}
                        </Text>
                      ) : null}
                      <Text style={[styles.date, checked && styles.textOn]}>
                        {formatDate(txn.date)}
                      </Text>
                    </>
                  )}
                  {txn.repeatRuleId ? (
                    <Ionicons
                      name="repeat"
                      size={13}
                      color={checked ? colors.white : colors.muted}
                    />
                  ) : null}
                  <Text
                    style={[styles.amount, checked && styles.textOn]}
                    numberOfLines={1}
                  >
                    {txn.inflow > 0 ? formatMoney(txn.inflow) : `−${formatMoney(txn.outflow)}`}
                  </Text>
                </Pressable>
                {editingTxnId === txn.id ? (
                  <InlineAddRow
                    budget={budget}
                    budgetId={budgetId}
                    transaction={txn}
                    onClose={onCloseEdit}
                  />
                ) : null}
              </View>
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: colors.card,
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  headerText: {
    color: colors.text,
    fontSize: 14,
    fontWeight: '600',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 9,
    paddingHorizontal: 12,
  },
  rowSelected: {
    backgroundColor: colors.indigo,
  },
  // Derived card installment: dimmed like an upcoming register row.
  rowInstallment: { opacity: 0.6 },
  fraction: {
    fontSize: 10,
    fontWeight: '700',
    paddingVertical: 1,
    paddingHorizontal: 7,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: 'hidden',
    fontVariant: ['tabular-nums'],
    flexShrink: 0,
  },
  fractionOn: { backgroundColor: colors.indigo2, color: colors.white },
  checkHit: { padding: 2 },
  boxSpacer: { width: 18, height: 18 },
  box: {
    width: 18,
    height: 18,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxChecked: {
    backgroundColor: colors.indigo2,
    borderColor: colors.indigo2,
  },
  name: {
    color: colors.text,
    fontSize: 13,
    flexShrink: 1,
    flexGrow: 1,
  },
  date: {
    color: colors.text,
    fontSize: 13,
  },
  stack: { flex: 1, minWidth: 0, gap: 3 },
  stackName: { color: colors.text, fontSize: 13 },
  stackMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  stackDate: { color: colors.muted, fontSize: 12 },
  textOn: { color: colors.white, fontWeight: '600' },
  amount: {
    color: colors.text,
    fontSize: 13,
    marginLeft: 'auto',
    textAlign: 'right',
    minWidth: 96,
  },
});
