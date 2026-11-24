/**
 * RegisterList — the Accounts screen's virtualized transaction register: one
 * row per visible transaction (table row at desktop width, two-line card
 * otherwise, the inline editor for the row being edited) plus the Scheduled
 * Transactions section (list header on phone, footer elsewhere).
 */

import { FlatList, StyleSheet, type GestureResponderEvent } from 'react-native';

import type { Person } from '@/domain/people';
import { registerCategoryCell } from '@/domain/register';
import type { Budget, Cents, Transaction } from '@/domain/types';
import { InlineAddRow } from './register/InlineAddRow';
import type { RegisterDensity } from './AccountsToolbar';
import { RegisterCard, RegisterRow } from './RegisterRow';
import { ScheduledSection } from './ScheduledSection';

export function RegisterList({
  budget,
  budgetId,
  rows,
  scheduled,
  isPhone,
  showWide,
  density,
  selectedAccountId,
  editingTxnId,
  onEditingChange,
  onEditPhone,
  selectedIds,
  showOwnerSlot,
  personOf,
  showRunningBalance,
  runningBalances,
  onPressRow,
  onToggleSelected,
  onApprove,
  onToggleCleared,
  onOpenMenu,
  onOpenTransfer,
}: {
  budget: Budget;
  budgetId: string;
  /** Register rows (today and earlier), newest first. */
  rows: Transaction[];
  /** Future-dated rows for the Scheduled section. */
  scheduled: Transaction[];
  isPhone: boolean;
  /** Desktop width: table rows + inline editor. */
  showWide: boolean;
  density: RegisterDensity;
  /** null = All Accounts (phone cards then name the account). */
  selectedAccountId: string | null;
  editingTxnId: string | null;
  onEditingChange: (id: string | null) => void;
  /** Phone/tablet editor: the calculator sheet. */
  onEditPhone: (txn: Transaction) => void;
  selectedIds: ReadonlySet<string>;
  showOwnerSlot: boolean;
  personOf: (userId: string | null) => Person | null;
  showRunningBalance: boolean;
  runningBalances: ReadonlyMap<string, Cents>;
  onPressRow: (txn: Transaction, e: GestureResponderEvent) => void;
  onToggleSelected: (id: string) => void;
  onApprove: (txn: Transaction) => void;
  onToggleCleared: (txn: Transaction) => void;
  onOpenMenu: (txn: Transaction, pageX: number, pageY: number) => void;
  onOpenTransfer: (txn: Transaction, pageX: number, pageY: number) => void;
}) {
  return (
    <FlatList
      data={rows}
      keyExtractor={(t) => t.id}
      // tk-lj5l (item 7): phone hosts Scheduled under the hero (list
      // header, above the register rows); desktop keeps the footer.
      ListHeaderComponent={
        isPhone ? (
          <ScheduledSection
            budget={budget}
            budgetId={budgetId}
            rows={scheduled}
            editingTxnId={editingTxnId}
            showWide={showWide}
            style={styles.scheduledPhone}
            onEditWide={(t) => onEditingChange(t.id)}
            onEditPhone={onEditPhone}
            onCloseEdit={() => onEditingChange(null)}
          />
        ) : undefined
      }
      ListFooterComponent={
        isPhone ? undefined : (
          <ScheduledSection
            budget={budget}
            budgetId={budgetId}
            rows={scheduled}
            editingTxnId={editingTxnId}
            showWide={showWide}
            onEditWide={(t) => onEditingChange(t.id)}
            onEditPhone={onEditPhone}
            onCloseEdit={() => onEditingChange(null)}
          />
        )
      }
      renderItem={({ item: t }) => {
        const acct = budget.accounts.find((a) => a.id === t.accountId);
        const cat = registerCategoryCell(budget, t);
        if (!showWide) {
          return (
            <RegisterCard
              txn={t}
              budget={budget}
              budgetId={budgetId}
              account={acct}
              category={cat}
              density={density}
              showAccount={!selectedAccountId}
              onEdit={() => onEditPhone(t)}
              onEditMemo={() => onEditPhone(t)}
              onApprove={onApprove}
              onToggleCleared={onToggleCleared}
              onOpenMenu={onOpenMenu}
              onOpenTransfer={onOpenTransfer}
            />
          );
        }
        if (editingTxnId === t.id) {
          return (
            <InlineAddRow
              budget={budget}
              budgetId={budgetId}
              transaction={t}
              onClose={() => onEditingChange(null)}
            />
          );
        }
        return (
          <RegisterRow
            txn={t}
            budget={budget}
            budgetId={budgetId}
            account={acct}
            category={cat}
            density={density}
            selected={selectedIds.has(t.id)}
            showOwnerSlot={showOwnerSlot}
            owner={showOwnerSlot && acct ? personOf(acct.userId) : null}
            showRunningBalance={showRunningBalance}
            runningBalance={runningBalances.get(t.id)}
            onPress={onPressRow}
            onToggleSelected={onToggleSelected}
            onEditMemo={() => onEditPhone(t)}
            onApprove={onApprove}
            onToggleCleared={onToggleCleared}
            onOpenMenu={onOpenMenu}
            onOpenTransfer={onOpenTransfer}
          />
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  scheduledPhone: { paddingHorizontal: 20, paddingBottom: 8 },
});
