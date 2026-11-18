/**
 * State and actions of the Manage Payees screen: the payee list query, the
 * selection with its per-payee drafts (name, renaming rule, merge target),
 * and every mutation. The panes render from the returned object.
 */

import { useMemo, useRef, useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppSelector } from '@/store/hooks';
import type { CategorizationMode, MatchType } from '@shared/domain/payees';

import {
  useAddCategoryMutation,
  useAddPayeeMutation,
  useDeletePayeeMutation,
  useGetPayeesQuery,
  useMergePayeesMutation,
  useRenamePayeeMutation,
  useSetPayeeCategorizationMutation,
  useSetPayeeHiddenMutation,
  useSetPayeeRenameRuleMutation,
} from '../../data/api';
import type { PayeeAdminRow } from '../../data/rows';
import { useBudgetModel } from '../../model/useBudgetModel';
import { selectActiveMonth } from '../../state/ui';
import { filterPayees, mergeCandidatesFor, renameToCommit, ruleToSave, type RuleDraft } from './payees.logic';

export type PayeeAdmin = ReturnType<typeof usePayeeAdmin>;

export function usePayeeAdmin() {
  const { budget: modelBudget, budgetId: activeBudgetId } = useBudgetModel();
  const budgetId = activeBudgetId ?? '';
  const scope = { budgetId };
  const payees = useGetPayeesQuery(scope, { skip: !budgetId });

  const [renamePayee] = useRenamePayeeMutation();
  const [setHidden] = useSetPayeeHiddenMutation();
  const [setCategorization] = useSetPayeeCategorizationMutation();
  const [mergePayees] = useMergePayeesMutation();
  const [deletePayee] = useDeletePayeeMutation();
  const [addPayee] = useAddPayeeMutation();
  const [setRenameRule] = useSetPayeeRenameRuleMutation();
  const [addCategory] = useAddCategoryMutation();

  // pickerBudget: the model is the active budget — same id
  // every caller used to pass, guarded anyway.
  const pickerBudget = modelBudget && modelBudget.id === budgetId ? modelBudget : undefined;
  const activeMonth = useAppSelector((s) => selectActiveMonth(s));

  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [showTxns, setShowTxns] = useState(false);
  // Renaming-rule draft for the selected payee; null until touched, so the
  // rendered value tracks the payee's saved rule until the user edits it.
  const [ruleDraft, setRuleDraft] = useState<RuleDraft | null>(null);
  const [newName, setNewName] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Rename conflict (409) shown under the name field, separate from the banner.
  const [nameError, setNameError] = useState<string | null>(null);
  // Prompt visibility is separate from the picked target: the target stays
  // null until a real pick in the searchable select — no preselected default.
  const [mergeOpen, setMergeOpen] = useState(false);
  const [mergeTargetId, setMergeTargetId] = useState<string | null>(null);
  // Latest name draft, readable synchronously so blur-after-Enter can't
  // re-commit the same rename.
  const nameDraftRef = useRef<string | null>(null);

  const all = useMemo(() => payees.data ?? [], [payees.data]);
  const filtered = useMemo(() => filterPayees(all, search), [all, search]);

  const selected = all.find((p) => p.id === selectedId) ?? null;
  const mergeCandidates = mergeCandidatesFor(all, selected);

  // Reset the detail pane together with the selection; selectById lets the
  // add-row path select a freshly created row it doesn't have an object for.
  const selectById = (id: string) => {
    setSelectedId(id);
    setNameDraft(null);
    nameDraftRef.current = null;
    setShowTxns(false);
    setRuleDraft(null);
    setMergeOpen(false);
    setMergeTargetId(null);
    setError(null);
    setNameError(null);
  };

  const select = (p: PayeeAdminRow) => selectById(p.id);

  /** Typing in the name field: track the draft and drop stale errors. */
  const editName = (v: string) => {
    nameDraftRef.current = v;
    setNameDraft(v);
    setNameError(null);
    setError(null);
  };

  const commitRename = async () => {
    if (!selected) return;
    const draft = nameDraftRef.current;
    nameDraftRef.current = null;
    setNameDraft(null);
    const name = renameToCommit(draft, selected.name);
    if (name == null) return;
    try {
      await renamePayee({ budgetId, payeeId: selected.id, name }).unwrap();
    } catch (err) {
      // The draft was already cleared above, so the field reverts to the saved name.
      const message = apiErrorMessage(err, 'failed to rename payee');
      if ((err as { status?: unknown } | null)?.status === 409) setNameError(message);
      else setError(message);
    }
  };

  /** Commit the selected payee's renaming rule; empty condition clears it. */
  const saveRule = async (patch?: Partial<RuleDraft>) => {
    if (!selected) return;
    const next = ruleToSave(ruleDraft, selected, patch);
    if (!next) {
      setRuleDraft(null);
      return;
    }
    try {
      await setRenameRule({ budgetId, payeeId: selected.id, matchType: next.matchType, condition: next.condition }).unwrap();
      setRuleDraft(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to save renaming rule'));
    }
  };

  /** Create a payee from the list pane's inline add row; select it after. */
  const addNewPayee = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const row = await addPayee({ budgetId, name }).unwrap();
      setNewName('');
      setSearch('');
      selectById(row.id);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to add payee'));
    }
  };

  const toggleHidden = async () => {
    if (!selected) return;
    try {
      await setHidden({ budgetId, payeeId: selected.id, hidden: !selected.hidden }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update payee'));
    }
  };

  const setCategorizationMode = async (mode: CategorizationMode) => {
    if (!selected) return;
    try {
      await setCategorization({
        budgetId,
        payeeId: selected.id,
        categorizationMode: mode,
        defaultCategoryId: selected.default_category_id,
      }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update categorization'));
    }
  };

  const setDefaultCategory = async (defaultCategoryId: string | null) => {
    if (!selected) return;
    try {
      await setCategorization({
        budgetId,
        payeeId: selected.id,
        categorizationMode: 'fixed',
        defaultCategoryId,
      }).unwrap();
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to update categorization'));
    }
  };

  const doDelete = async () => {
    if (!selected) return;
    try {
      await deletePayee({ budgetId, payeeId: selected.id }).unwrap();
      setSelectedId(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to delete payee'));
    }
  };

  /**
   * Delete semantics per YNAB: with transactions, deleting would orphan
   * them — offer a merge into a surviving payee instead. Without
   * transactions, soft-delete straight away.
   */
  const tryDelete = () => {
    if (!selected) return;
    if (selected.transaction_count > 0) setMergeOpen(true);
    else void doDelete();
  };

  /** Standalone "Merge into…": same prompt the delete fallback opens. */
  const openMerge = () => {
    if (!selected) return;
    setMergeOpen(true);
  };

  const cancelMerge = () => {
    setMergeOpen(false);
    setMergeTargetId(null);
  };

  const doMerge = async () => {
    if (!selected || !mergeTargetId) return;
    try {
      await mergePayees({ budgetId, payeeId: selected.id, targetPayeeId: mergeTargetId }).unwrap();
      setSelectedId(null);
      setMergeOpen(false);
      setMergeTargetId(null);
      setError(null);
    } catch (err) {
      setError(apiErrorMessage(err, 'failed to merge payees'));
    }
  };

  const busy = payees.isLoading;
  /** Matcher shown when no unsaved draft: the payee's stored rule, else Contains. */
  const draftMatchType: MatchType = ruleDraft?.matchType ?? selected?.rename_match_type ?? 'contains';

  return {
    budgetId,
    pickerBudget,
    activeMonth,
    addCategory,
    busy,
    search,
    setSearch,
    newName,
    setNewName,
    addNewPayee,
    filtered,
    selectedId,
    selected,
    select,
    error,
    setError,
    nameDraft,
    nameError,
    editName,
    commitRename,
    showTxns,
    setShowTxns,
    setCategorizationMode,
    setDefaultCategory,
    ruleDraft,
    setRuleDraft,
    draftMatchType,
    saveRule,
    toggleHidden,
    mergeOpen,
    mergeCandidates,
    mergeTargetId,
    setMergeTargetId,
    openMerge,
    cancelMerge,
    doMerge,
    tryDelete,
  };
}
