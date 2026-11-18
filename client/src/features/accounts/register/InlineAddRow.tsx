/**
 * Inline add / edit row for the desktop register — YNAB-style entry (bead:
 * inline add). A table row whose cells are inputs: account, date, payee,
 * category, memo, amount; plus Cancel / Save (and, when creating,
 * Save and add another). Reuses the register column flexes so it lines up
 * with the header and rows below. With `transaction` set, the row edits that
 * transaction in place (wide row click instead of the calculator sheet).
 * The calculator sheet stays the phone/tablet entry; this row is desktop-only.
 */

import { StyleSheet, Text, TextInput, View, Pressable } from 'react-native';

import { transferPayeeName } from '@shared/domain/transfers';

import { useGetPayeesQuery } from '@/budget/data/api';
import { todayIso } from '@/domain/format';
import { draftMonthKey } from '@/domain/inlineAdd';
import type { Budget, Transaction } from '@/domain/types';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { AmountCell } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { AccountDropdown } from '@/ui/dropdown/AccountDropdown';
import { CategoryDropdown } from '@/ui/dropdown/CategoryDropdown';
import { DatePickerPopover } from '@/ui/dropdown/DatePickerPopover';
import { InlineConvPanel } from './InlineConvPanel';
import { InlineRepeatFooter } from './InlineRepeatFooter';
import { InlineSplitPanel } from './InlineSplitPanel';
import { PayeeDropdown } from './PayeeDropdown';
import { useInlineAdd } from './useInlineAdd';

// The repeat frequencies live with the row's pure rules; re-exported here for
// the row menu's Make Repeating (syscd-app-42f) and other importers.
export { REPEAT_FREQS, REPEAT_LABELS } from '@/domain/inlineAdd';

export function InlineAddRow({
  budget,
  budgetId,
  defaultAccountId,
  transaction,
  onClose,
}: {
  budget: Budget;
  budgetId: string;
  /** Pre-selected account when the screen has one filtered; else first account. */
  defaultAccountId?: string | null;
  /** When set, the row edits this existing transaction instead of creating one. */
  transaction?: Transaction;
  onClose: () => void;
}) {
  const row = useInlineAdd({ budget, budgetId, defaultAccountId, transaction, onClose });
  const { editing, account, dateText, dateIso, payee, categoryId, memo, outflow, inflow, error, repeatFreq, usd, save, createCategory } = row;
  const payees = useGetPayeesQuery({ budgetId });
  // Menu amounts are month-scoped: AVAILABLE for the month the typed date
  // lands in (today when the date is blank), plus the live Ready-to-Assign.
  const bm = useBudgetMonth(budget, draftMonthKey(dateIso, todayIso()));
  return (
    <View style={styles.wrap} testID="register-row">
      <View style={styles.row}>
        <AccountDropdown
          accounts={budget.accounts}
          currentAccountId={account?.id ?? null}
          onPick={row.setAccountId}
          placeholder="Account"
          chevron
          containerStyle={{ flex: 1.1 }}
          accessibilityLabel="Account"
        />
        <DatePickerPopover
          value={dateText}
          onChangeText={row.setDateText}
          onEscape={onClose}
          onEnter={() => void save(true)}
          style={[styles.input, !dateIso && dateText.trim() ? styles.inputInvalid : null]}
          containerStyle={{ flex: 0.7 }}
          accessibilityLabel="Date"
          footer={
            <InlineRepeatFooter
              transaction={transaction}
              repeatFreq={repeatFreq}
              onFreqChange={row.setRepeatFreq}
              open={row.repeatOpen}
              onOpenChange={row.setRepeatOpen}
              onStop={() => void row.stopRepeating()}
              onMake={() => void save(true)}
            />
          }
        />
        <PayeeDropdown
          value={payee}
          onChangeText={row.setPayee}
          payees={payees.data ?? []}
          accounts={budget.accounts}
          currentAccountId={account?.id ?? null}
          placeholder="Payee"
          chevron
          containerStyle={{ flex: 1.4 }}
          accessibilityLabel="Payee"
        />
        <CategoryDropdown
          categories={budget.categories}
          groups={budget.groups}
          bundles={budget.bundles}
          currentCategoryId={categoryId}
          bm={bm}
          accounts={budget.accounts}
          payeeValue={payee}
          onPick={(picked) => {
            row.setCategoryId(picked);
            // Un-split gesture (syscd-app-rlt): choosing a single category
            // while the split panel is open collapses the legs into one
            // categorized row; the closed panel saves without splits.
            row.setSplitsOpen(false);
          }}
          onCreate={(query) => void createCategory(query)}
          onTransferPick={(pickedId) => {
            const target = budget.accounts.find((a) => a.id === pickedId);
            if (!target) return;
            row.setPayee(transferPayeeName(target.name));
            row.setCategoryId(null);
          }}
          onSplitPick={row.openSplitEditor}
          placeholder="Category"
          chevron
          containerStyle={{ flex: 1.4 }}
          accessibilityLabel="Category"
        />
        <TextInput
          value={memo}
          onChangeText={row.setMemo}
          placeholder="Memo"
          placeholderTextColor={colors.faint}
          style={[styles.input, { flex: 1.2 }]}
          accessibilityLabel="Memo"
          onKeyPress={(e) => {
            if (e.nativeEvent.key === 'Enter') void save(true);
            if (e.nativeEvent.key === 'Escape') onClose();
          }}
        />
        <AmountCell
          outflowCents={outflow}
          inflowCents={inflow}
          onChange={row.onAmountCommit}
          style={{ flex: 1.1, minWidth: 0 }}
        />
        {/* Cleared-column spacer — keeps cells aligned with the register header.
            Cleared stays editable only from the row badge / selection bar. */}
        <View style={styles.clearedCell} />
      </View>
      {row.splitsOpen ? (
        <InlineSplitPanel
          budget={budget}
          bm={bm}
          splits={row.splits}
          onChange={row.setSplits}
          onDone={() => void save(true)}
          onCreateCategory={(query, assign) => void createCategory(query, assign)}
        />
      ) : null}
      {repeatFreq && usd ? (
        <InlineConvPanel
          usd={usd}
          cents={usd.field === 'outflow' ? outflow : inflow}
          onCommit={row.onConvCommit}
          rateData={row.rateData}
          rateFetching={row.rateFetching}
          rateError={row.rateError}
          onRetry={() => void row.refetchRate()}
        />
      ) : null}
      <View style={styles.actions}>
        <Pressable
          onPress={onClose}
          style={styles.btnGhost}
          accessibilityLabel={editing ? 'Cancel editing transaction' : 'Cancel new transaction'}>
          <Text style={styles.btnGhostText}>Cancel</Text>
        </Pressable>
        {!editing ? (
          <Pressable
            onPress={() => void save(true)}
            style={styles.btnGhost}
            accessibilityLabel="Save transaction and add another">
            <Text style={styles.btnGhostText}>Save and add another</Text>
          </Pressable>
        ) : (
          row.saving && (
            <Text style={styles.btnGhostText}>Saving…</Text>
          )
        )}
        {error ? (
          <Text style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.indigoSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 6,
  },
  input: {
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    color: colors.text,
    paddingVertical: 6,
    paddingHorizontal: 10,
    fontSize: 13,
    minWidth: 0,
  },
  inputInvalid: { borderColor: colors.red },
  clearedCell: { width: 30 },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 2,
    paddingBottom: 10,
  },
  btnGhost: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 6,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
  },
  btnGhostText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  error: { color: colors.redFg, fontSize: 12 },
});
