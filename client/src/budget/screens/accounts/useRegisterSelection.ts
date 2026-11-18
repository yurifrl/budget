/**
 * useRegisterSelection: multi-select for the register's selection action bar
 * (Images #7/#8/#9). Owns the checked ids and the shift-click anchor, derives
 * the bar's flags through domain/registerSelection, and wires every bulk
 * action (categorize/flag/clear/memo, match, duplicate, move, export, delete)
 * and the web keyboard shortcuts to its mutation.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { GestureResponderEvent } from 'react-native';

import {
  useAddTransactionMutation,
  useDeleteTransactionMutation,
  useUpdateTransactionMutation,
} from '../../data/api';
import type { TransactionInput } from '../../data/mapping';
import { todayIso } from '../../domain/format';
import {
  allRowsSelected,
  duplicateDraft,
  rowPressIntent,
  selectionAllCleared,
  selectionCanMatch,
  selectionMoveTargets,
  selectionShortcut,
  selectRange,
  toggleAllVisible,
  toggleId,
  unmatchTargets,
} from '../../domain/registerSelection';
import type { Budget, Transaction } from '../../domain/types';
import { downloadCsv, matchCandidates, txnsCsv } from '../register/txnRowMenuShared';

export function useRegisterSelection({
  budget,
  budgetId,
  selectedAccountId,
  transactions,
  registerTxns,
  shortcutsBlocked,
  setEditingTxnId,
}: {
  budget: Budget | null | undefined;
  budgetId: string | null | undefined;
  selectedAccountId: string | null;
  /** Every row in scope (selection survives filters). */
  transactions: Transaction[];
  /** The visible register rows: select-all and shift-range work on these. */
  registerTxns: Transaction[];
  /** An editor, row menu or reconcile session owns the keyboard. */
  shortcutsBlocked: boolean;
  setEditingTxnId: (id: string | null) => void;
}) {
  const [updateTransaction] = useUpdateTransactionMutation();
  const [addTransaction] = useAddTransactionMutation();
  const [deleteTransaction] = useDeleteTransactionMutation();

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  // Shift-click range anchor (web, YNAB register): the last row the user
  // clicked or toggled; the next shift-click selects everything between.
  const [selAnchorId, setSelAnchorId] = useState<string | null>(null);
  // Scope switch (rail account change) invalidates stale ids.
  useEffect(() => {
    setSelectedIds(new Set());
    setSelAnchorId(null);
  }, [selectedAccountId]);

  const selectedTxns = useMemo(
    () => transactions.filter((t) => selectedIds.has(t.id)),
    [transactions, selectedIds],
  );
  // More-menu enablement (Image #2): Match needs exactly one selectable
  // candidate pair (the row-menu flow stays the multi-candidate picker);
  // Unmatch needs a matched row in the selection.
  const canMatch = useMemo(
    () => !!budget && selectionCanMatch(selectedTxns, (t) => matchCandidates(t, budget)),
    [selectedTxns, budget],
  );
  const hasMatched = selectedTxns.some((t) => t.matchedTransactionId);
  /** Mark-as label direction: all-cleared selection flips to "Mark as Uncleared". */
  const allCleared = selectionAllCleared(selectedTxns);

  const allRegisterSelected = allRowsSelected(registerTxns, selectedIds);
  const toggleSelectAllVisible = () => {
    setSelectedIds((prev) => toggleAllVisible(prev, registerTxns, allRegisterSelected));
  };

  // Selection patches (categorize/flag/clear/memo): one mutation per row.
  const patchSelected = useCallback(
    (patch: Partial<TransactionInput>, after?: () => void) => {
      if (!budgetId) return;
      for (const t of selectedTxns) {
        void updateTransaction({ budgetId, id: t.id, patch });
      }
      setSelectedIds(new Set());
      after?.();
    },
    [budgetId, selectedTxns, updateTransaction],
  );

  // Clear does NOT approve: approving repaints the row (indigoSoft =
  // unapproved) and clearing must not change the line color.
  const clearSelected = useCallback(
    (cleared?: 'cleared' | 'uncleared' | 'reconciled') => {
      patchSelected({
        cleared: cleared ?? (allCleared ? 'uncleared' : 'cleared'),
      });
    },
    [allCleared, patchSelected],
  );

  const matchSelected = useCallback(() => {
    if (!budgetId || !canMatch) return;
    const [a, b] = selectedTxns;
    void updateTransaction({ budgetId, id: a.id, patch: { matchedTransactionId: b.id } });
    void updateTransaction({ budgetId, id: b.id, patch: { matchedTransactionId: a.id } });
    setSelectedIds(new Set());
  }, [budgetId, canMatch, selectedTxns, updateTransaction]);

  const unmatchSelected = useCallback(() => {
    if (!budgetId) return;
    for (const id of unmatchTargets(selectedTxns, selectedIds)) {
      void updateTransaction({ budgetId, id, patch: { matchedTransactionId: null } });
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, selectedIds, updateTransaction]);

  const duplicateSelected = useCallback(() => {
    if (!budgetId) return;
    for (const t of selectedTxns) {
      void addTransaction({ budgetId, txn: duplicateDraft(t) });
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, addTransaction]);

  const memoSelected = () => {
    if (process.env.EXPO_OS === 'web') {
      const memo = window.prompt('Memo', selectedTxns.length === 1 ? (selectedTxns[0].memo ?? '') : '');
      if (memo === null) return;
      patchSelected({ memo });
      return;
    }
    // Native: fall back to the row's inline editor on the first selected row.
    setEditingTxnId(selectedTxns[0]?.id ?? null);
    setSelectedIds(new Set());
  };

  const exportSelected = () => {
    if (!budget) return;
    if (process.env.EXPO_OS === 'web') {
      downloadCsv(`transactions-${todayIso()}.csv`, txnsCsv(selectedTxns, budget));
    }
  };

  const deleteSelected = useCallback(() => {
    if (!budgetId) return;
    if (process.env.EXPO_OS === 'web' && !window.confirm(`Delete ${selectedTxns.length} transaction(s)?`)) return;
    for (const t of selectedTxns) {
      void deleteTransaction({ budgetId, id: t.id });
    }
    setSelectedIds(new Set());
  }, [budgetId, selectedTxns, deleteTransaction]);

  // Selection shortcuts (web, Image #2 keycaps): C marks cleared/uncleared,
  // M matches, shift+U unmatches, shift+D duplicates, delete/backspace
  // deletes. Claimed only while a selection exists and no editor, row menu,
  // or reconcile popover owns the interaction; text fields skip so inline
  // typing is untouched.
  useEffect(() => {
    if (process.env.EXPO_OS !== 'web') return undefined;
    if (selectedTxns.length === 0) return undefined;
    if (shortcutsBlocked) return undefined;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable))
      return undefined;
    const onKey = (ev: KeyboardEvent) => {
      const action = selectionShortcut(ev, { allCleared, hasMatched, canMatch });
      if (!action) return;
      if (action.kind === 'clear') {
        ev.preventDefault();
        clearSelected(action.cleared);
      } else if (action.kind === 'unmatch') unmatchSelected();
      else if (action.kind === 'duplicate') duplicateSelected();
      else if (action.kind === 'match') matchSelected();
      else deleteSelected();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [
    selectedTxns,
    canMatch,
    hasMatched,
    allCleared,
    shortcutsBlocked,
    clearSelected,
    matchSelected,
    unmatchSelected,
    duplicateSelected,
    deleteSelected,
  ]);

  const moveTargets = budget ? selectionMoveTargets(budget.accounts, selectedTxns) : [];
  const moveToSelected = (accountId: string) => {
    if (!budgetId) return;
    for (const t of selectedTxns) {
      if (t.accountId === accountId) continue;
      void updateTransaction({ budgetId, id: t.id, patch: { accountId } });
    }
    setSelectedIds(new Set());
  };

  /** Row checkbox: flip the row and make it the shift-range anchor. */
  const toggleRow = (id: string) => {
    setSelectedIds((prev) => toggleId(prev, id));
    setSelAnchorId(id);
  };

  // Register row press (web, YNAB register): plain click opens the inline
  // editor; ctrl/cmd-click toggles the row's selection; shift-click selects
  // the whole range from the last-clicked anchor. Modifier keys exist only
  // on web pointer events (RN's responder event doesn't type them).
  const pressRegisterRow = (t: Transaction, e: GestureResponderEvent) => {
    const mod = e as unknown as { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
    const intent = rowPressIntent(process.env.EXPO_OS === 'web', mod);
    if (intent === 'open') {
      // Plain click opens the inline editor; reconciled rows are locked
      // (syscd-app-lqu) and stay non-editable; selection is always allowed.
      if (t.cleared === 'reconciled') return;
      setEditingTxnId(t.id);
      return;
    }
    setEditingTxnId(null);
    if (intent === 'range') setSelectedIds((prev) => selectRange(prev, registerTxns, selAnchorId, t.id));
    else setSelectedIds((prev) => toggleId(prev, t.id));
    setSelAnchorId(t.id);
  };

  return {
    selectedIds,
    selectedTxns,
    canMatch,
    hasMatched,
    allCleared,
    allRegisterSelected,
    toggleSelectAllVisible,
    patchSelected,
    clearSelected,
    matchSelected,
    unmatchSelected,
    duplicateSelected,
    memoSelected,
    exportSelected,
    deleteSelected,
    moveTargets,
    moveToSelected,
    toggleRow,
    pressRegisterRow,
    clearSelection: () => setSelectedIds(new Set()),
  };
}
