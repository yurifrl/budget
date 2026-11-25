/**
 * State and actions of the Renaming card: one editor row per rule of the
 * payee (several), the "new rule" row, and the "Apply to past transactions"
 * flow (preview, apply). The saved rule is written into the payee list cache
 * at once, so a row never flashes its old value while the list refetches.
 */

import { useReducer, useRef, useState } from 'react';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppDispatch } from '@/state/hooks';
import {
  budgetApi,
  useAddPayeeRenameRuleMutation,
  useApplyRenameRuleMutation,
  useLazyPreviewRenameRuleApplyQuery,
  useRemovePayeeRenameRuleMutation,
  useUpdatePayeeRenameRuleMutation,
  type RenameRuleApplyResult,
  type RenameRulePreview,
} from '@/budget/data/api';
import type { RuleMatchType } from '@shared/domain/payees';
import type { PayeeAdminRow } from '@/budget/data/rows';
import { t } from './i18n';
import {
  EMPTY_EDITOR,
  NEW_KEY,
  editorReducer,
  editorRows,
  planCommit,
  withRule,
  withoutRule,
  type RuleFields,
  type SavedRule,
} from './renameRules.logic';

export type ApplyView =
  | { ruleId: string; phase: 'loading' }
  | { ruleId: string; phase: 'ready'; preview: RenameRulePreview; applying: boolean; error: string | null }
  | { ruleId: string; phase: 'error'; message: string };

export type RenameRules = ReturnType<typeof useRenameRules>;

const fieldsOf = (r: SavedRule): RuleFields => ({ matchType: r.match_type, condition: r.condition });

export function useRenameRules({
  budgetId,
  payee,
  onApplied,
}: {
  budgetId: string;
  payee: PayeeAdminRow;
  /** The apply went through: the screen offers Undo. */
  onApplied: (result: RenameRuleApplyResult) => void;
}) {
  const dispatch = useAppDispatch();
  const [state, send] = useReducer(editorReducer, EMPTY_EDITOR);
  const [addRule] = useAddPayeeRenameRuleMutation();
  const [updateRule] = useUpdatePayeeRenameRuleMutation();
  const [removeRule] = useRemovePayeeRenameRuleMutation();
  const [preview] = useLazyPreviewRenameRuleApplyQuery();
  const [applyRule] = useApplyRenameRuleMutation();
  const [applyView, setApplyView] = useState<ApplyView | null>(null);
  // blur, Enter and end-editing all fire for one commit: the first one wins.
  const inflight = useRef(new Set<string>());

  const rules: SavedRule[] = payee.rename_rules ?? [];
  const rows = editorRows(rules, state);

  const patchList = (recipe: (list: PayeeAdminRow[]) => PayeeAdminRow[]) =>
    dispatch(budgetApi.util.updateQueryData('getPayeesWithTransfers', { budgetId }, (list) => recipe(list)));

  const edit = (key: string, patch: Partial<RuleFields>) => {
    const saved = rules.find((r) => r.id === key);
    const base = saved ? fieldsOf(saved) : (state.drafts[key] ?? { matchType: 'contains' as const, condition: '' });
    send({ type: 'edit', key, base, patch });
  };

  /** Save one row (blur / Enter, or a picked match type). Nothing is sent for an empty or unchanged row. */
  const commit = async (key: string, patch?: Partial<RuleFields>) => {
    if (inflight.current.has(key)) return;
    const saved = key === NEW_KEY ? null : (rules.find((r) => r.id === key) ?? null);
    const stored = state.drafts[key] ?? (saved ? fieldsOf(saved) : undefined);
    const draft = stored ? { ...stored, ...patch } : undefined;
    const plan = planCommit(saved, draft);
    if (plan.kind === 'none') {
      // An existing row goes back to its stored rule; the new row stays open.
      if (saved) send({ type: 'drop', key });
      return;
    }
    inflight.current.add(key);
    send({ type: 'saving', key });
    try {
      const row =
        plan.kind === 'add'
          ? await addRule({ budgetId, payeeId: payee.id, rule: plan.rule }).unwrap()
          : await updateRule({ budgetId, payeeId: payee.id, ruleId: plan.ruleId, rule: plan.rule }).unwrap();
      patchList((list) => withRule(list, row));
      send({ type: 'saved', key });
    } catch (err) {
      send({ type: 'failed', key, message: apiErrorMessage(err, t('error.saveRule')) });
    } finally {
      inflight.current.delete(key);
    }
  };

  /** A picked match type: a stored rule saves it now, the new row keeps it in its draft. */
  const pickMatchType = (key: string, matchType: RuleMatchType) => {
    if (key === NEW_KEY) edit(key, { matchType });
    else void commit(key, { matchType });
  };

  const remove = async (key: string) => {
    if (key === NEW_KEY) {
      send({ type: 'drop', key });
      return;
    }
    if (inflight.current.has(key)) return;
    inflight.current.add(key);
    send({ type: 'saving', key });
    try {
      await removeRule({ budgetId, payeeId: payee.id, ruleId: key }).unwrap();
      patchList((list) => withoutRule(list, payee.id, key));
      send({ type: 'saved', key });
      setApplyView((v) => (v?.ruleId === key ? null : v));
    } catch (err) {
      send({ type: 'failed', key, message: apiErrorMessage(err, t('error.removeRule')) });
    } finally {
      inflight.current.delete(key);
    }
  };

  // --- Apply to past transactions ---------------------------------------------

  const openApply = async (ruleId: string) => {
    setApplyView({ ruleId, phase: 'loading' });
    try {
      const result = await preview({ budgetId, payeeId: payee.id, ruleId }, false).unwrap();
      setApplyView({ ruleId, phase: 'ready', preview: result, applying: false, error: null });
    } catch (err) {
      setApplyView({ ruleId, phase: 'error', message: apiErrorMessage(err, t('apply.error.preview')) });
    }
  };

  const closeApply = () => setApplyView(null);

  const confirmApply = async () => {
    if (applyView?.phase !== 'ready' || applyView.applying) return;
    const { ruleId, preview: shown } = applyView;
    setApplyView({ ruleId, phase: 'ready', preview: shown, applying: true, error: null });
    try {
      const result = await applyRule({ budgetId, payeeId: payee.id, ruleId }).unwrap();
      setApplyView(null);
      onApplied(result);
    } catch (err) {
      setApplyView({ ruleId, phase: 'ready', preview: shown, applying: false, error: apiErrorMessage(err, t('apply.error.apply')) });
    }
  };

  return {
    rows,
    empty: rules.length === 0 && !state.drafts[NEW_KEY],
    edit,
    commit,
    pickMatchType,
    remove,
    openNew: () => send({ type: 'openNew' }),
    applyView,
    openApply,
    closeApply,
    confirmApply,
  };
}
