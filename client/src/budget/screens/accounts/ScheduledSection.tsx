/**
 * ScheduledSection — YNAB-style "Scheduled Transactions" block at the bottom
 * of the register (syscd-app-5nz): a collapsible header listing every
 * future-dated transaction in the current search scope. Rows use the compact
 * scheduled-row design: selection checkbox, flag + attachment glyphs, account
 * name, date, and (for repeat-rule occurrences) a repeat glyph before the
 * right-aligned amount. Selecting the checkbox highlights the row; pressing
 * the row opens the same editor a register row would (inline on desktop, the
 * edit sheet on phone).
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import { formatDate, formatMoney } from '../../domain/format';
import type { Budget, Transaction } from '../../domain/types';
import { colors } from '../../ui/theme';
import { InlineAddRow } from '../register/InlineAddRow';

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
    <View accessibilityLabel="Scheduled Transactions" style={style}>
      <Pressable
        style={styles.header}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((o) => !o)}
      >
        <Ionicons name="calendar-outline" size={15} color={colors.muted} />
        <Text style={styles.headerText}>Scheduled Transactions</Text>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={colors.muted} />
      </Pressable>
      {open
        ? rows.map((txn) => {
            const checked = selected.has(txn.id);
            const account = budget.accounts.find((a) => a.id === txn.accountId);
            return (
              <View key={txn.id}>
                <Pressable
                  style={[styles.row, checked && styles.rowSelected]}
                  accessibilityLabel={`Scheduled transaction ${txn.payee || account?.name || ''}`}
                  onPress={() => openEditor(txn)}
                >
                  <Pressable
                    style={styles.checkHit}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked }}
                    accessibilityLabel={`Select scheduled transaction ${txn.payee || account?.name || ''}`}
                    onPress={() => toggle(txn.id)}
                  >
                    <View style={[styles.box, checked && styles.boxChecked]}>
                      {checked ? (
                        <Ionicons name="checkmark" size={13} color="#fff" />
                      ) : null}
                    </View>
                  </Pressable>
                  <Ionicons name="bookmark-outline" size={15} color={colors.faint} />
                  <Ionicons name="image-outline" size={15} color={colors.faint} />
                  <Text
                    style={[styles.name, checked && styles.textOn]}
                    numberOfLines={1}
                  >
                    {account?.name ?? txn.payee ?? ''}
                  </Text>
                  <Text style={[styles.date, checked && styles.textOn]}>
                    {formatDate(txn.date)}
                  </Text>
                  {txn.repeatRuleId ? (
                    <Ionicons
                      name="repeat"
                      size={13}
                      color={checked ? '#fff' : colors.muted}
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
  checkHit: { padding: 2 },
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
  textOn: { color: '#fff', fontWeight: '600' },
  amount: {
    color: colors.text,
    fontSize: 13,
    marginLeft: 'auto',
    textAlign: 'right',
    minWidth: 96,
  },
});
