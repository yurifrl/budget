/**
 * useTransfers: the transfer suggestions of the active budget (one query for
 * the chip count, the review list and the register popover), the popover
 * target, and the link / Undo / "not a transfer" actions with their toast.
 * "Always treat X as a transfer" is a renaming rule added on the other
 * account's transfer payee after the link; the old per-payee rule is never written.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  useAddPayeeRenameRuleMutation,
  useGetPayeesWithTransfersQuery,
  useGetTransactionsQuery,
  useGetTransferSuggestionsQuery,
  useLazyGetPayeeRenameRulesQuery,
  useLinkTransfersMutation,
  useMarkTransfersMutation,
  useUnlinkTransfersMutation,
  type TransferLinkInput,
  type TransferSuggestion,
} from '@/budget/data/api';
import { apiErrorMessage, apiErrorParam } from '@/platform/api/baseQuery';
import { t } from './i18n';
import { errorCode, ruleExistsOutcome, type RuleDraft, ruleToCreate } from './transferRule.logic';
import { findSuggestion, linkedToast, scopeSuggestions } from './transfers.logic';

/** The other side of a link and the rule to remember for it ("Always treat ... as a transfer"). */
export interface LinkRule {
  accountId: string;
  draft: RuleDraft;
}

const EMPTY: TransferSuggestion[] = [];

export interface TransferToastState {
  text: string;
  undo?: () => void;
}

export function useTransfers({ budgetId, accountId }: { budgetId: string | null | undefined; accountId: string | null }) {
  const scope = { budgetId: budgetId ?? '' };
  const query = useGetTransferSuggestionsQuery(scope, { skip: !budgetId });
  const all = query.data ?? EMPTY;
  const scoped = useMemo(() => scopeSuggestions(all, accountId), [all, accountId]);
  const [link] = useLinkTransfersMutation();
  const [unlink] = useUnlinkTransfersMutation();
  const [mark] = useMarkTransfersMutation();
  const [addRule] = useAddPayeeRenameRuleMutation();
  const [readRules] = useLazyGetPayeeRenameRulesQuery();
  // The row's own bank text (for the rule) and the accounts' transfer payees (where the rule goes).
  const rows = useGetTransactionsQuery(scope, { skip: !budgetId });
  const payees = useGetPayeesWithTransfersQuery(scope, { skip: !budgetId });

  const [toast, setToast] = useState<TransferToastState | null>(null);
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), toast.undo ? 7000 : 3500);
    return () => clearTimeout(id);
  }, [toast]);

  const [popover, setPopover] = useState<{ txnId: string; x: number; y: number } | null>(null);
  const popoverItem = popover ? findSuggestion(all, popover.txnId) : undefined;

  const undoLinks = useCallback(
    async (ids: string[]) => {
      try {
        await unlink({ ...scope, transactionIds: ids }).unwrap();
        setToast({ text: t('toast.undone') });
      } catch (err) {
        setToast({ text: apiErrorMessage(err, t('error.unlink')) });
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [budgetId, unlink],
  );

  /** The text the bank sent for a row (its import text), else its payee: what a rule is built from. */
  const bankTextOf = (txnId: string): string | null => {
    const row = rows.data?.find((r) => r.id === txnId);
    return (row?.import_payee_name_original ?? row?.import_payee_name ?? row?.payee_name ?? null)?.trim() || null;
  };

  /**
   * Add the renaming rule on the account's transfer payee. "Already there" is
   * saved only when the transfer payee itself holds it (read again); when
   * another payee holds it, the rule was NOT saved and the message says so.
   * Any other refusal comes back as the message to show.
   */
  const saveRule = async (rule: LinkRule): Promise<{ saved: boolean; message?: string }> => {
    const body = ruleToCreate(true, rule.draft);
    if (!body) return { saved: false, message: t('rule.notSaved.invalid') };
    const target = payees.data?.find((p) => p.transfer_account_id === rule.accountId && !p.deleted);
    if (!target) return { saved: false, message: t('rule.notSaved.noPayee') };
    try {
      await addRule({ ...scope, payeeId: target.id, rule: body }).unwrap();
      return { saved: true };
    } catch (err) {
      if (errorCode(err) === 'rename_rule_exists') {
        try {
          return ruleExistsOutcome(await readRules({ ...scope, payeeId: target.id }, false).unwrap(), body, apiErrorParam(err, 'name'));
        } catch (readErr) {
          return { saved: false, message: apiErrorMessage(readErr, t('error.rule')) };
        }
      }
      return { saved: false, message: apiErrorMessage(err, t('error.rule')) };
    }
  };

  /** Link pairs (or a row to an account), then remember the rule if asked; resolves true when the link went through. */
  const linkMany = async (links: TransferLinkInput[], rule: LinkRule | null = null): Promise<boolean> => {
    if (!budgetId || links.length === 0) return false;
    try {
      const result = await link({ ...scope, links }).unwrap();
      const ruled = rule ? await saveRule(rule) : null;
      setToast({ text: linkedToast(result, ruled), undo: () => void undoLinks(result.linked) });
      return true;
    } catch (err) {
      setToast({ text: apiErrorMessage(err, t('error.link')) });
      return false;
    }
  };

  const dismiss = async (ids: string[]): Promise<boolean> => {
    if (!budgetId || ids.length === 0) return false;
    try {
      await mark({ ...scope, transactionIds: ids, state: 'dismissed' }).unwrap();
      const undo = () =>
        void mark({ ...scope, transactionIds: ids, state: null })
          .unwrap()
          .then(() => setToast({ text: t('toast.undone') }))
          .catch((err: unknown) => setToast({ text: apiErrorMessage(err, t('error.dismiss')) }));
      setToast({ text: t('toast.dismissed', { count: ids.length }), undo });
      return true;
    } catch (err) {
      setToast({ text: apiErrorMessage(err, t('error.dismiss')) });
      return false;
    }
  };

  return {
    all,
    scoped,
    loading: query.isLoading,
    popover,
    popoverItem,
    openPopover: (txnId: string, x: number, y: number) => setPopover({ txnId, x, y }),
    closePopover: () => setPopover(null),
    linkMany,
    dismiss,
    bankTextOf,
    transferPayeeOf: (accountId: string) => payees.data?.find((p) => p.transfer_account_id === accountId && !p.deleted),
    toast,
    closeToast: () => setToast(null),
  };
}

export type TransfersState = ReturnType<typeof useTransfers>;
