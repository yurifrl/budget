/**
 * useTransfers: the transfer suggestions of the active budget (one query for
 * the chip count, the review list and the register popover), the popover
 * target, and the link / Undo / "not a transfer" actions with their toast.
 */
import { useCallback, useEffect, useState } from 'react';

import {
  useGetTransferSuggestionsQuery,
  useLinkTransfersMutation,
  useMarkTransfersMutation,
  useUnlinkTransfersMutation,
  type TransferLinkInput,
  type TransferSuggestion,
} from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { t } from './i18n';
import { findSuggestion, linkedToast } from './transfers.logic';

const EMPTY: TransferSuggestion[] = [];

export interface TransferToastState {
  text: string;
  undo?: () => void;
}

export function useTransfers({ budgetId }: { budgetId: string | null | undefined }) {
  const scope = { budgetId: budgetId ?? '' };
  const query = useGetTransferSuggestionsQuery(scope, { skip: !budgetId });
  const all = query.data ?? EMPTY;
  const [link] = useLinkTransfersMutation();
  const [unlink] = useUnlinkTransfersMutation();
  const [mark] = useMarkTransfersMutation();

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

  /** Link pairs (or a row to an account); resolves true on success. */
  const linkMany = async (links: TransferLinkInput[], rememberPayee = false): Promise<boolean> => {
    if (!budgetId || links.length === 0) return false;
    try {
      const result = await link({ ...scope, links, rememberPayee }).unwrap();
      setToast({ text: linkedToast(result), undo: () => void undoLinks(result.linked) });
      return true;
    } catch (err) {
      setToast({ text: apiErrorMessage(err, t('error.link')) });
      return false;
    }
  };

  const setMark = async (ids: string[], state: 'dismissed' | 'outside'): Promise<boolean> => {
    if (!budgetId || ids.length === 0) return false;
    try {
      await mark({ ...scope, transactionIds: ids, state }).unwrap();
      const undo = () =>
        void mark({ ...scope, transactionIds: ids, state: null })
          .unwrap()
          .then(() => setToast({ text: t('toast.undone') }))
          .catch((err: unknown) => setToast({ text: apiErrorMessage(err, t('error.dismiss')) }));
      setToast({ text: state === 'dismissed' ? t('toast.dismissed', { count: ids.length }) : t('toast.outside'), undo });
      return true;
    } catch (err) {
      setToast({ text: apiErrorMessage(err, t('error.dismiss')) });
      return false;
    }
  };

  return {
    popover,
    popoverItem,
    openPopover: (txnId: string, x: number, y: number) => setPopover({ txnId, x, y }),
    closePopover: () => setPopover(null),
    linkMany,
    dismiss: (ids: string[]) => setMark(ids, 'dismissed'),
    keepOutside: (ids: string[]) => setMark(ids, 'outside'),
    toast,
    closeToast: () => setToast(null),
  };
}

export type TransfersState = ReturnType<typeof useTransfers>;
