/**
 * Inline add / edit row for the desktop register — YNAB-style entry (bead:
 * inline add). A table row whose cells are inputs: account, date, payee,
 * category, memo, amount; plus Cancel / Save (and, when creating,
 * Save and add another). Reuses the register column flexes so it lines up
 * with the header and rows below. With `transaction` set, the row edits that
 * transaction in place (wide row click instead of the calculator sheet).
 * The calculator sheet stays the phone/tablet entry; this row is desktop-only.
 */

import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { DatePickerPopover } from './DatePickerPopover';
import { pressNoBlur } from './dropdown';
import { transferPayeeName } from '@shared/domain/transfers';
import { PayeeDropdown } from './PayeeDropdown';
import { AccountDropdown } from './AccountDropdown';
import { CategoryDropdown } from './CategoryDropdown';

import {
  useAddCategoryMutation,
  useAddRepeatRuleMutation,
  useAddTransactionMutation,
  useDeleteRepeatRuleMutation,
  useGetPayeesQuery,
  useGetUsdBrlRateQuery,
  useUpdateTransactionMutation,
} from '../../data/api';
import type { TransactionInput } from '../../data/mapping';
import { useBudgetMonth } from '../../model/useBudgetMonth';
import { formatUsd, isUsdDraft, makeMonth, todayIso } from '../../domain/format';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import type { Budget, Cents, Transaction, TransactionSplit, RepeatFrequency } from '../../domain/types';
import { editDirty, newDraftDirty, type RowDraft } from '../../domain/rowEdit';
import { AmountCell, MoneyInput } from '../../ui/bits';
import { colors, radius } from '../../ui/theme';

/** Frequencies the calendar-footer Repeat dropdown offers (server FREQUENCIES). Shared with the row menu's Make Repeating (syscd-app-42f). */
export const REPEAT_FREQS: RepeatFrequency[] = [
  'weekly',
  'every-other-week',
  'monthly',
  'every-other-month',
  'quarterly',
  'annually',
];
export const REPEAT_LABELS: Record<RepeatFrequency, string> = {
  weekly: 'Every week',
  'every-other-week': 'Every other week',
  monthly: 'Monthly',
  'every-other-month': 'Every other month',
  quarterly: 'Quarterly',
  annually: 'Yearly',
};

/** RepeatCadence values a rule can actually use (a stored txn may carry any cadence). */
const isRepeatFreq = (cadence: string): cadence is RepeatFrequency =>
  (REPEAT_FREQS as string[]).includes(cadence);

/** Fresh split leg for the editor: one-way amounts start empty (syscd-app-rlt). */
const emptySplit = (): TransactionSplit => ({
  id: `draft-${Math.random().toString(36).slice(2)}`,
  categoryId: null,
  memo: '',
  outflow: 0,
  inflow: 0,
});

/**
 * Parent-amount for a split: the signed sum of its legs (YNAB requires the
 * legs to total the parent). One-way on the wire — mixed legs collapse to the
 * net direction.
 */
const splitTotals = (splits: TransactionSplit[]): { outflow: Cents; inflow: Cents } => {
  const net = splits.reduce((acc, s) => acc + s.inflow - s.outflow, 0);
  return net >= 0 ? { outflow: 0, inflow: net } : { outflow: -net, inflow: 0 };
};

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
  const { formatDate, formatMoney, parseDateInput, prefs: fmtPrefs } = useMoneyFormat();
  const editing = transaction != null;
  const [accountId, setAccountId] = useState(
    transaction?.accountId ?? defaultAccountId ?? budget.accounts[0]?.id ?? '',
  );
  const [dateText, setDateText] = useState(() => formatDate(transaction?.date ?? todayIso()));
  const [payee, setPayee] = useState(transaction?.payee ?? '');
  const [categoryId, setCategoryId] = useState<string | null>(transaction?.categoryId ?? null);
  const [memo, setMemo] = useState(transaction?.memo ?? '');
  const [outflow, setOutflow] = useState(transaction?.outflow ?? 0);
  const [inflow, setInflow] = useState(transaction?.inflow ?? 0);
  const [error, setError] = useState<string | null>(null);
  // Calendar-footer Repeat control (syscd-app-pya): null = never. An
  // already-repeating transaction keeps its rule; the footer then offers
  // Stop Repeating instead of a frequency swap.
  const [repeatFreq, setRepeatFreq] = useState<RepeatFrequency | null>(
    transaction?.repeatRuleId && isRepeatFreq(transaction.repeat)
      ? (transaction.repeat as RepeatFrequency)
      : null,
  );
  const [repeatOpen, setRepeatOpen] = useState(false);
  // Split editor (syscd-app-rlt): legs replace the single category/outflow/
  // inflow when saved. Seeded from the transaction's existing splits, else
  // with one empty leg. Editing a split transaction starts with the panel
  // open so the seeded legs are visible and editable.
  const [splitsOpen, setSplitsOpen] = useState(!!transaction?.splits?.length);
  const [splits, setSplits] = useState<TransactionSplit[]>(() =>
    transaction?.splits?.length
      ? transaction.splits.map((s) => ({ ...s }))
      : [emptySplit()],
  );
  // USD draft on a scheduled row: the amount was typed with a "$" prefix
  // (e.g. "$100"), so it is USD and the ledger (BRL) amount is its
  // conversion. Auto-filled from the indicative rate until the captain
  // edits the conversion field (convEdited).
  const [usd, setUsd] = useState<{ cents: Cents; field: 'outflow' | 'inflow' } | null>(null);
  const [convEdited, setConvEdited] = useState(false);

  const payees = useGetPayeesQuery({ budgetId });
  const [addTransaction, addState] = useAddTransactionMutation();
  const [updateTransaction, updateState] = useUpdateTransactionMutation();
  const [addCategory, addCategoryState] = useAddCategoryMutation();
  const [addRepeatRule, addRuleState] = useAddRepeatRuleMutation();
  const [deleteRepeatRule, deleteRuleState] = useDeleteRepeatRuleMutation();
  // Indicative USD→BRL rate — fetched only once a USD draft exists on a
  // scheduled (repeating) row; cached server-side.
  const {
    data: rateData,
    isFetching: rateFetching,
    isError: rateError,
    refetch: refetchRate,
  } = useGetUsdBrlRateQuery(undefined, { skip: !usd });

  // Auto-fill the conversion once the rate arrives (captain hasn't edited it).
  useEffect(() => {
    const rate = rateData?.rate;
    if (!repeatFreq || !usd || convEdited || rate == null) return;
    const brl = Math.round(usd.cents * rate);
    if (usd.field === 'outflow') setOutflow(brl);
    else setInflow(brl);
  }, [repeatFreq, usd, convEdited, rateData]);

  const account = budget.accounts.find((a) => a.id === accountId) ?? budget.accounts[0];

  // Latest dirty/commit — the outside-press listener reads through refs so it
  // stays mounted with stable deps while the draft state moves.
  const dirtyRef = useRef<() => boolean>(() => false);
  dirtyRef.current = () => {
    const d: RowDraft = {
      accountId: accountId ?? account?.id ?? '',
      date: parseDateInput(dateText) ?? (dateText.trim() ? '' : todayIso()),
      payee,
      categoryId,
      memo,
      outflowCents: outflow,
      inflowCents: inflow,
    };
    return editing && transaction
      ? editDirty(transaction, d, splitsOpen ? splits : undefined)
      : newDraftDirty(
          d,
          defaultAccountId ?? budget.accounts[0]?.id ?? '',
          todayIso(),
        );
  };
  const commitRef = useRef<() => void>(() => {});
  commitRef.current = () => {
    if (dirtyRef.current()) void save(false);
    else onClose();
  };
  // YNAB auto-save (web): an outside click commits the row — no Save
  // button. The click event (not pointerdown) matters: input blur-commit
  // runs first, so a just-typed amount is already in state when the dirty
  // check and save read it — committing on pointerdown races the blur and
  // saves 0. The row itself and the register's popover portals are
  // excluded: a dropdown pick fires within them, so it never commits.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return;
    const onDocClick = (e: MouseEvent) => {
      if (!(e.target instanceof Element)) return;
      if (e.target.closest('[data-testid="register-row"], [data-testid="register-popover"]')) return;
      commitRef.current();
    };
    document.addEventListener('click', onDocClick, true);
    return () => document.removeEventListener('click', onDocClick, true);
  }, []);

  const resetForNext = () => {
    setDateText(formatDate(todayIso()));
    setPayee('');
    setCategoryId(null);
    setMemo('');
    setOutflow(0);
    setInflow(0);
    setUsd(null);
    setConvEdited(false);
    setRepeatFreq(null);
    setRepeatOpen(false);
    setSplitsOpen(false);
    setSplits([emptySplit()]);
    setError(null);
  };

  /** Split footer button: open the leg editor and clear the single category. */
  const openSplitEditor = () => {
    setCategoryId(null);
    setSplitsOpen(true);
    setOutflow(0);
    setInflow(0);
    setUsd(null);
    setConvEdited(false);
  };

  // Amount commits with the raw text — a "$" prefix marks the draft as USD.
  // Direction comes from the cell's non-zero side. A direction-toggle commit
  // (no raw text) keeps the USD draft; only magnitude edits reset it.
  const onAmountCommit = (
    { outflowCents, inflowCents }: { outflowCents: Cents; inflowCents: Cents },
    raw?: string,
  ) => {
    setOutflow(outflowCents);
    setInflow(inflowCents);
    if (raw === undefined) return;
    const field: 'outflow' | 'inflow' = outflowCents !== 0 ? 'outflow' : 'inflow';
    setUsd(raw && isUsdDraft(raw) ? { cents: outflowCents !== 0 ? outflowCents : inflowCents, field } : null);
    setConvEdited(false);
  };
  // Conversion edit in the scheduled panel: keep the typed USD source, only
  // change the ledger amount, and stop auto-fill.
  const onConvCommit = (cents: Cents) => {
    setConvEdited(true);
    if (usd?.field === 'outflow') setOutflow(cents);
    else if (usd) setInflow(cents);
  };

  const save = async (keepOpen: boolean) => {
    if (
      !budgetId ||
      !account ||
      addState.isLoading ||
      updateState.isLoading ||
      addCategoryState.isLoading ||
      addRuleState.isLoading ||
      deleteRuleState.isLoading
    )
      return;
    setError(null);
    const draftSplits = splitsOpen ? splits : [];
    if (outflow === 0 && inflow === 0 && !draftSplits.some((s) => s.outflow !== 0 || s.inflow !== 0)) {
      setError('enter an amount');
      return;
    }
    const date = parseDateInput(dateText) ?? (dateText.trim() ? null : todayIso());
    if (!date) {
      setError(`invalid date — try ${fmtPrefs.dateFormat} or 5, 5/9`);
      return;
    }
    if (draftSplits.length > 0 && draftSplits.some((s) => !s.categoryId)) {
      setError('every split needs a category');
      return;
    }
    if (draftSplits.length > 0 && draftSplits.every((s) => s.outflow === 0 && s.inflow === 0)) {
      setError('enter an amount on each split');
      return;
    }
    // Legs count only while the split panel is open — a closed panel means a
    // plain categorized row (explicit un-split gesture in edit mode).
    const liveSplits = splitsOpen ? splits.filter((s) => s.outflow !== 0 || s.inflow !== 0) : [];
    const totals = liveSplits.length > 0 ? splitTotals(liveSplits) : null;
    // Scheduled USD draft: the ledger amount is the BRL conversion — the
    // rate-fetched value, or whatever the captain typed in the conversion
    // field (convEdited). Split legs and non-scheduled rows save as typed.
    let outflowCents = totals ? totals.outflow : inflow > 0 ? 0 : outflow;
    let inflowCents = totals ? totals.inflow : inflow > 0 ? inflow : 0;
    if (repeatFreq && usd && !convEdited && totals == null) {
      const rate = rateData?.rate;
      if (rate == null) {
        setError(
          rateFetching
            ? 'fetching the USD→BRL rate — try again in a moment'
            : 'no exchange rate available — enter the amount in R$ (without $)',
        );
        return;
      }
      const brl = Math.round(usd.cents * rate);
      if (usd.field === 'outflow') outflowCents = brl;
      else inflowCents = brl;
    }
    try {
      if (editing && transaction) {
        // Closed panel = no splits. Editing a split transaction auto-opens
        // the panel, so a closed panel in edit mode is the user's explicit
        // un-split: the picked single category replaces the legs.
        const patch = {
          accountId: account.id,
          date,
          payee: payee.trim(),
          // Splits force the parent category to NULL ("Split"); the server
          // rejects a split carrying a category_id. The parent amount is the
          // leg total so account balances move by the split's real sum.
          categoryId: totals ? null : categoryId,
          memo: memo.trim(),
          outflowCents,
          inflowCents,
        };
        await updateTransaction({
          budgetId,
          id: transaction.id,
          patch,
          // Splits save the full leg list (server replaces, never diffs).
          subtransactions: liveSplits.map((s) => ({
            categoryId: s.categoryId,
            memo: s.memo,
            outflowCents: s.outflow,
            inflowCents: s.inflow,
          })),
        }).unwrap();
        // Make Repeating on an existing row: keep the edited transaction as
        // the series anchor; the server schedules the next occurrences.
        if (repeatFreq && !transaction.repeatRuleId) {
          await addRepeatRule({
            budgetId,
            accountId: account.id,
            payee: patch.payee,
            categoryId: patch.categoryId,
            memo: patch.memo,
            outflowCents: patch.outflowCents,
            inflowCents: patch.inflowCents,
            frequency: repeatFreq,
            monthLastDay: false,
            attachTransactionId: transaction.id,
          }).unwrap();
        }
        onClose();
        return;
      }
      // Legs were hoisted above `try` — a closed panel means a plain
      // single-category row.
      const txn: TransactionInput = {
        accountId: account.id,
        date,
        payee: payee.trim(),
        categoryId: totals ? null : categoryId,
        memo: memo.trim(),
        outflowCents,
        inflowCents,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: 'never',
      };
      const created = await addTransaction({
        budgetId,
        txn,
        subtransactions: liveSplits.map((s) => ({
          categoryId: s.categoryId,
          memo: s.memo,
          outflowCents: s.outflow,
          inflowCents: s.inflow,
        })),
      }).unwrap();
      // Repeat on save (new row): the just-entered transaction becomes the
      // anchor and future occurrences materialize immediately (upcoming).
      if (repeatFreq) {
        await addRepeatRule({
          budgetId,
          accountId: account.id,
          payee: txn.payee,
          categoryId: txn.categoryId,
          memo: txn.memo,
          outflowCents: txn.outflowCents,
          inflowCents: txn.inflowCents,
          frequency: repeatFreq,
          monthLastDay: false,
          attachTransactionId: created.id,
        }).unwrap();
      }
      if (keepOpen) resetForNext();
      else onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to save transaction');
    }
  };

  /** Cancel the series: deletes the rule; pending upcoming instances are removed by the server. */
  const stopRepeating = async () => {
    if (!budgetId || !transaction?.repeatRuleId || deleteRuleState.isLoading) return;
    setError(null);
    try {
      await deleteRepeatRule({ budgetId, ruleId: transaction.repeatRuleId }).unwrap();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to stop repeat');
    }
  };

  const createCategory = async (query: string, assign?: (id: string) => void) => {
    const group = budget.groups[0];
    if (!group || !query) return;
    setError(null);
    try {
      const created = await addCategory({
        budgetId,
        groupId: group.id,
        name: query,
        sortOrder: budget.categories.length,
      }).unwrap();
      if (assign) assign(created.id);
      else setCategoryId(created.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to create category');
    }
  };

  const dateIso = parseDateInput(dateText) ?? (dateText.trim() ? null : todayIso());
  // Menu amounts are month-scoped: AVAILABLE for the month the typed date
  // lands in (today when the date is blank), plus the live Ready-to-Assign.
  const [monthYear, monthNum] = (dateIso ?? todayIso()).split('-');
  const monthKey = makeMonth(Number(monthYear), Number(monthNum));
  const bm = useBudgetMonth(budget, monthKey);

  return (
    <View style={styles.wrap} testID="register-row">
      <View style={styles.row}>
        <AccountDropdown
          accounts={budget.accounts}
          currentAccountId={account?.id ?? null}
          onPick={setAccountId}
          placeholder="Account"
          chevron
          containerStyle={{ flex: 1.1 }}
          accessibilityLabel="Account"
        />
        <DatePickerPopover
          value={dateText}
          onChangeText={setDateText}
          onEscape={onClose}
          onEnter={() => void save(true)}
          style={[styles.input, !dateIso && dateText.trim() ? styles.inputInvalid : null]}
          containerStyle={{ flex: 0.7 }}
          accessibilityLabel="Date"
          footer={
            transaction?.repeatRuleId ? (
              <View style={styles.repeatBar}>
                <Text style={styles.repeatLabel}>
                  Repeats {REPEAT_LABELS[transaction.repeat as RepeatFrequency] ?? transaction.repeat}
                </Text>
                <Pressable style={styles.repeatStop} onPress={() => void stopRepeating()}>
                  <Text style={styles.repeatStopText}>Stop Repeating</Text>
                </Pressable>
              </View>
            ) : (
              <View style={styles.repeatBar}>
                <Text style={styles.repeatLabel}>Repeat</Text>
                <View style={styles.repeatPicker}>
                  <Pressable
                    style={styles.repeatTrigger}
                    onPress={() => setRepeatOpen((v) => !v)}
                    {...pressNoBlur}
                    accessibilityLabel="Repeat frequency">
                    <Text style={styles.repeatTriggerText}>
                      {repeatFreq ? REPEAT_LABELS[repeatFreq] : 'Never'}
                    </Text>
                    <Text style={styles.repeatCaret}>▾</Text>
                  </Pressable>
                  {repeatOpen ? (
                    <View style={styles.repeatMenu}>
                      <Pressable
                        style={styles.repeatItem}
                        onPress={() => {
                          setRepeatFreq(null);
                          setRepeatOpen(false);
                        }}
                        {...pressNoBlur}>
                        <Text style={[styles.repeatItemText, repeatFreq === null && styles.repeatItemActive]}>
                          Never
                        </Text>
                      </Pressable>
                      {REPEAT_FREQS.map((f) => (
                        <Pressable
                          key={f}
                          style={styles.repeatItem}
                          onPress={() => {
                            setRepeatFreq(f);
                            setRepeatOpen(false);
                          }}
                          {...pressNoBlur}>
                          <Text style={[styles.repeatItemText, repeatFreq === f && styles.repeatItemActive]}>
                            {REPEAT_LABELS[f]}
                          </Text>
                        </Pressable>
                      ))}
                    </View>
                  ) : null}
                </View>
                {repeatFreq ? (
                  <Pressable style={styles.repeatMake} onPress={() => void save(true)} {...pressNoBlur}>
                    <Text style={styles.repeatMakeText}>Make Repeating</Text>
                  </Pressable>
                ) : null}
              </View>
            )
          }
        />
        <PayeeDropdown
          value={payee}
          onChangeText={setPayee}
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
            setCategoryId(picked);
            // Un-split gesture (syscd-app-rlt): choosing a single category
            // while the split panel is open collapses the legs into one
            // categorized row; the closed panel saves without splits.
            setSplitsOpen(false);
          }}
          onCreate={(query) => void createCategory(query)}
          onTransferPick={(pickedId) => {
            const target = budget.accounts.find((a) => a.id === pickedId);
            if (!target) return;
            setPayee(transferPayeeName(target.name));
            setCategoryId(null);
          }}
          onSplitPick={openSplitEditor}
          placeholder="Category"
          chevron
          containerStyle={{ flex: 1.4 }}
          accessibilityLabel="Category"
        />
        <TextInput
          value={memo}
          onChangeText={setMemo}
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
          onChange={onAmountCommit}
          style={{ flex: 1.1, minWidth: 0 }}
        />
        {/* Cleared-column spacer — keeps cells aligned with the register header.
            Cleared stays editable only from the row badge / selection bar. */}
        <View style={styles.clearedCell} />
      </View>
      {splitsOpen ? (
        <View style={styles.splitPanel}>
          <View style={styles.splitHead}>
            <Text style={styles.splitHeadText}>Split across categories</Text>
            <Text
              style={[styles.splitTotal, splitTotals(splits).outflow + splitTotals(splits).inflow === 0 && styles.splitTotalZero]}>
              {splitTotals(splits).outflow > 0
                ? `${formatMoney(splitTotals(splits).outflow)} out`
                : splitTotals(splits).inflow > 0
                  ? `${formatMoney(splitTotals(splits).inflow)} in`
                  : 'no amount'}
            </Text>
            <Pressable onPress={() => void save(true)} style={styles.splitDone} accessibilityLabel="Done splitting">
              <Text style={styles.splitDoneText}>Done</Text>
            </Pressable>
          </View>
          {splits.map((leg, i) => {
            const legCat = budget.categories.find((c) => c.id === leg.categoryId) ?? null;
            return (
              <View key={leg.id} style={styles.splitLeg}>
                <CategoryDropdown
                  categories={budget.categories}
                  groups={budget.groups}
                  bundles={budget.bundles}
                  currentCategoryId={leg.categoryId}
                  bm={bm}
                  accounts={budget.accounts}
                  onPick={(picked) =>
                    setSplits((prev) => prev.map((s, j) => (j === i ? { ...s, categoryId: picked } : s)))
                  }
                  onTransferPick={() => undefined}
                  onCreate={(query) =>
                    void createCategory(query, (id) =>
                      setSplits((prev) => prev.map((s, j) => (j === i ? { ...s, categoryId: id } : s))),
                    )
                  }
                  placeholder={legCat?.name ?? 'Category'}
                  containerStyle={{ flex: 1.4 }}
                  accessibilityLabel={`Split ${i + 1} category`}
                />
                <TextInput
                  value={leg.memo}
                  onChangeText={(t) => setSplits((prev) => prev.map((s, j) => (j === i ? { ...s, memo: t } : s)))}
                  placeholder="Memo"
                  placeholderTextColor={colors.faint}
                  style={[styles.input, { flex: 1.2 }]}
                  accessibilityLabel={`Split ${i + 1} memo`}
                />
                <AmountCell
                  outflowCents={leg.outflow}
                  inflowCents={leg.inflow}
                  onChange={({ outflowCents, inflowCents }) =>
                    setSplits((prev) => prev.map((s, j) => (j === i ? { ...s, outflow: outflowCents, inflow: inflowCents } : s)))
                  }
                  style={{ flex: 1.1, minWidth: 0 }}
                />
                <Pressable
                  onPress={() => setSplits((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : [emptySplit()]))}
                  style={styles.splitRemove}
                  accessibilityLabel={`Remove split ${i + 1}`}>
                  <Text style={styles.splitRemoveText}>✕</Text>
                </Pressable>
              </View>
            );
          })}
          <Pressable onPress={() => setSplits((prev) => [...prev, emptySplit()])} style={styles.splitAdd}>
            <Text style={styles.splitAddText}>+ Add another split</Text>
          </Pressable>
        </View>
      ) : null}
      {repeatFreq && usd ? (
        <View style={styles.convPanel}>
          {rateFetching && !rateData ? (
            <View style={styles.convRow}>
              <ActivityIndicator size="small" color={colors.indigo} />
              <Text style={styles.convLabel}>Fetching USD→BRL rate…</Text>
            </View>
          ) : (
            <View style={styles.convRow}>
              <Text style={styles.convLabel}>
                {usd.field === 'outflow' ? 'Outflow' : 'Inflow'} {formatUsd(usd.cents)} ≈
              </Text>
              <MoneyInput
                cents={usd.field === 'outflow' ? outflow : inflow}
                onCommit={onConvCommit}
                style={styles.convInput}
              />
              {rateData ? (
                <Text style={styles.convRate} accessibilityLabel="USD to BRL rate">
                  1 USD = {rateData.rate.toFixed(4)} BRL
                </Text>
              ) : null}
              {rateError ? (
                <Pressable onPress={() => void refetchRate()} style={styles.convRetry}>
                  <Text style={styles.convErrorText}>rate unavailable — retry</Text>
                </Pressable>
              ) : null}
            </View>
          )}
        </View>
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
          (updateState.isLoading || addState.isLoading) && (
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
  // Split editor (syscd-app-rlt).
  splitPanel: {
    paddingHorizontal: 20,
    paddingVertical: 8,
    marginHorizontal: 20,
    marginBottom: 4,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    gap: 6,
  },
  splitHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  splitHeadText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  splitTotal: { color: colors.text, fontSize: 12, fontWeight: '600', marginLeft: 'auto' },
  splitTotalZero: { color: colors.muted },
  splitDone: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 3,
    paddingHorizontal: 12,
    backgroundColor: colors.card,
  },
  splitDoneText: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  splitLeg: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  splitRemove: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  splitRemoveText: { color: colors.redFg, fontSize: 13 },
  splitAdd: { alignSelf: 'flex-start', paddingVertical: 2 },
  splitAddText: { color: colors.indigo, fontSize: 12, fontWeight: '700' },
  // Calendar-footer repeat bar (syscd-app-pya).
  repeatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  repeatLabel: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  repeatPicker: { position: 'relative' },
  repeatTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    backgroundColor: colors.card2,
    paddingVertical: 4,
    paddingHorizontal: 8,
  },
  repeatTriggerText: { color: colors.text, fontSize: 12 },
  repeatCaret: { color: colors.muted, fontSize: 10 },
  repeatMenu: {
    position: 'absolute',
    // Footer is pinned at the portal's bottom edge, so the menu must open
    // upward — a downward drop is clipped by dropdownPortal's overflow:'hidden'.
    bottom: '100%',
    left: 0,
    zIndex: 30,
    width: 170,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    // Grid area above the footer is ~200px in the flipped-up popover; keep the
    // menu inside it and scroll if a smaller portal leaves even less room.
    maxHeight: 192,
    overflow: 'scroll',
    paddingVertical: 3,
    shadowColor: '#000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 12,
  },
  repeatItem: { paddingVertical: 4, paddingHorizontal: 10 },
  repeatItemText: { color: colors.text, fontSize: 12 },
  repeatItemActive: { color: colors.indigo, fontWeight: '700' },
  repeatMake: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 12,
    marginLeft: 'auto',
  },
  repeatMakeText: { color: '#fff', fontSize: 12, fontWeight: '700' },
  repeatStop: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 10,
    marginLeft: 'auto',
    backgroundColor: colors.card,
  },
  repeatStopText: { color: colors.redFg, fontSize: 12, fontWeight: '600' },
  // Scheduled USD→BRL conversion panel.
  convPanel: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    paddingVertical: 8,
    paddingHorizontal: 12,
    marginTop: 6,
  },
  convRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  convLabel: { color: colors.muted, fontSize: 12 },
  convInput: { fontSize: 13, minWidth: 90 },
  convRate: { color: colors.faint, fontSize: 11, marginLeft: 'auto' },
  convRetry: { marginLeft: 'auto' },
  convErrorText: { color: colors.redFg, fontSize: 11 },
});

