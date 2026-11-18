/**
 * useInlineAdd: draft state and save flow of the register's inline add / edit
 * row. Holds the row's fields (account, date, payee, category, memo, amount,
 * split legs, repeat, scheduled USD draft), commits on an outside click (web)
 * and writes through the transaction / repeat-rule mutations. Validation and
 * payload shaping are the pure rules in domain/inlineAdd.
 */

import { useEffect, useRef, useState } from 'react';

import {
  useAddCategoryMutation,
  useAddRepeatRuleMutation,
  useAddTransactionMutation,
  useDeleteRepeatRuleMutation,
  useGetUsdBrlRateQuery,
  useUpdateTransactionMutation,
} from '../../data/api';
import type { TransactionInput } from '../../data/mapping';
import { todayIso } from '../../domain/format';
import {
  emptySplit,
  initialRepeatFreq,
  inlineRowDraft,
  planInlineSave,
  repeatRuleFields,
  resolveDraftDate,
  usdDraftFromCommit,
  usdToLedger,
  type UsdDraft,
} from '../../domain/inlineAdd';
import { editDirty, newDraftDirty } from '../../domain/rowEdit';
import type { Budget, Cents, RepeatFrequency, Transaction, TransactionSplit } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';

export function useInlineAdd({
  budget,
  budgetId,
  defaultAccountId,
  transaction,
  onClose,
}: {
  budget: Budget;
  budgetId: string;
  defaultAccountId?: string | null;
  transaction?: Transaction;
  onClose: () => void;
}) {
  const { formatDate, parseDateInput, prefs: fmtPrefs } = useMoneyFormat();
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
  const [repeatFreq, setRepeatFreq] = useState<RepeatFrequency | null>(initialRepeatFreq(transaction));
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
  const [usd, setUsd] = useState<UsdDraft | null>(null);
  const [convEdited, setConvEdited] = useState(false);

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
    const brl = usdToLedger(usd, rate);
    if (usd.field === 'outflow') setOutflow(brl);
    else setInflow(brl);
  }, [repeatFreq, usd, convEdited, rateData]);

  const account = budget.accounts.find((a) => a.id === accountId) ?? budget.accounts[0];

  // Latest dirty/commit — the outside-press listener reads through refs so it
  // stays mounted with stable deps while the draft state moves.
  const dirtyRef = useRef<() => boolean>(() => false);
  dirtyRef.current = () => {
    const d = inlineRowDraft(
      { accountId, dateText, payee, categoryId, memo, outflow, inflow },
      parseDateInput,
      todayIso(),
    );
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
    setUsd(usdDraftFromCommit(outflowCents, inflowCents, raw));
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
    const plan = planInlineSave(
      { accountId: account.id, dateText, payee, categoryId, memo, outflow, inflow, splitsOpen, splits, repeatFreq, usd, convEdited },
      { parseDateInput, today: todayIso(), dateFormat: fmtPrefs.dateFormat, rate: rateData?.rate, rateFetching },
    );
    if (!plan.ok) {
      setError(plan.error);
      return;
    }
    const { fields, subtransactions } = plan;
    try {
      if (editing && transaction) {
        // Closed panel = no splits. Editing a split transaction auto-opens
        // the panel, so a closed panel in edit mode is the user's explicit
        // un-split: the picked single category replaces the legs.
        await updateTransaction({
          budgetId,
          id: transaction.id,
          patch: fields,
          // Splits save the full leg list (server replaces, never diffs).
          subtransactions,
        }).unwrap();
        // Make Repeating on an existing row: keep the edited transaction as
        // the series anchor; the server schedules the next occurrences.
        if (repeatFreq && !transaction.repeatRuleId) {
          await addRepeatRule({ budgetId, ...repeatRuleFields(fields, repeatFreq, transaction.id) }).unwrap();
        }
        onClose();
        return;
      }
      // A closed panel means a plain single-category row.
      const txn: TransactionInput = {
        ...fields,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: 'never',
      };
      const created = await addTransaction({ budgetId, txn, subtransactions }).unwrap();
      // Repeat on save (new row): the just-entered transaction becomes the
      // anchor and future occurrences materialize immediately (upcoming).
      if (repeatFreq) {
        await addRepeatRule({ budgetId, ...repeatRuleFields(fields, repeatFreq, created.id) }).unwrap();
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

  return {
    editing,
    account,
    setAccountId,
    dateText,
    setDateText,
    /** Null while the typed date is unparseable. */
    dateIso: resolveDraftDate(dateText, parseDateInput, todayIso()),
    payee,
    setPayee,
    categoryId,
    setCategoryId,
    memo,
    setMemo,
    outflow,
    inflow,
    error,
    repeatFreq,
    setRepeatFreq,
    repeatOpen,
    setRepeatOpen,
    splitsOpen,
    setSplitsOpen,
    splits,
    setSplits,
    usd,
    rateData,
    rateFetching,
    rateError,
    refetchRate,
    /** Edit mode shows "Saving…" while a write is in flight. */
    saving: updateState.isLoading || addState.isLoading,
    openSplitEditor,
    onAmountCommit,
    onConvCommit,
    save,
    stopRepeating,
    createCategory,
  };
}
