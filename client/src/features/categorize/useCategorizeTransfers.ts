/**
 * Wiring of the page's Transfers section: Jev's transfer answers, the matcher's
 * own pairs (the register's review list and popover, reused here) and the three
 * answers to a Jev row — accept, not a transfer, skip. Accept rides the page's
 * accept flow, so the same toast and Undo cover a transfer; skip rides the same
 * "Leaving uncategorized" strip a category row does; refusing hides the row
 * while its answer is on its way and gives it back if the server says no.
 */

import { useMemo } from 'react';

import type { TransferSuggestion } from '@/budget/data/api';
import { useGetCategorizeTransfersQuery, useRefuseCategorizeTransferMutation } from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useTransfers, type TransfersState } from '@/features/transfers';

import { answeredIdSet } from './accept.logic';
import { t } from './i18n';
import {
  jevGroups,
  jevItems,
  visibleGroups,
  type TransferActions,
  type TransferGroupView,
  type TransferItem,
} from './transfer.logic';
import type { CategorizeAccept } from './useCategorizeAccept';

/** What the Transfers section renders and what its actions do. */
export interface CategorizeTransfers {
  /** Jev's answers, one entry per account and direction, in the order sent. */
  groups: readonly TransferGroupView[];
  /** The same answers flat, in wire order: the One by one pane's leading lines. */
  items: readonly TransferItem[];
  /**
   * How many answers the read lists, whatever the page has answered already:
   * the counter adds this number, so it never disagrees with the header.
   */
  count: number;
  loading: boolean;
  failed: boolean;
  retry: () => void;
  /** The matcher's own pairs (the register's list shows the same rows). */
  matcher: readonly TransferSuggestion[];
  matcherLoading: boolean;
  /** The matcher's actions: link, refuse, popover, toast. */
  matcherState: TransfersState;
  /** The one row's three answers, shared with the One by one pane. */
  actions: TransferActions;
  acceptGroup: (group: TransferGroupView) => Promise<boolean>;
  refused: (item: TransferItem) => Promise<boolean>;
  skipped: (item: TransferItem) => Promise<boolean>;
}

export function useCategorizeTransfers({
  budgetId,
  accept,
}: {
  budgetId: string | null;
  accept: CategorizeAccept;
}): CategorizeTransfers {
  // The matcher's pairs are the register's: same query, same list, same popover.
  const matcher = useTransfers({ budgetId, accountId: null });
  const jev = useGetCategorizeTransfersQuery({ budgetId: budgetId ?? '' }, { skip: !budgetId });
  const [refuse] = useRefuseCategorizeTransferMutation();

  // A row leaves the lists the moment it is answered, so the section and the
  // pane drop it while the server catches up. Only the answers the page has
  // taken (refused, skipped, accepted) hide; the queue's own rows never do.
  const hidden = useMemo(() => answeredIdSet(accept.state), [accept.state]);
  const read = useMemo(() => jev.data?.groups ?? [], [jev.data]);
  const answered = useMemo(() => jevGroups(read), [read]);
  const groups = useMemo(() => visibleGroups(answered, hidden), [answered, hidden]);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);
  const count = useMemo(() => jevItems(read).length, [read]);

  /** Accept Jev's answer for one row: the row is linked to the account it names. */
  const acceptOne = (item: TransferItem): Promise<boolean> => accept.acceptTransfers([item]);

  /** A whole account pair at once, the way a bundle card files its rows. */
  const acceptGroup = (group: TransferGroupView): Promise<boolean> => accept.acceptTransfers(group.items);

  /**
   * "Not a transfer": the pair is recorded, so a later run does not offer that
   * account for this row again. The row leaves the section at once, the way a
   * filed row does, and comes back if the server says no. A server code the page
   * knows keeps its own sentence; anything else gets the one this action owns.
   */
  const refused = async (item: TransferItem): Promise<boolean> => {
    if (!budgetId) return false;
    const hidden = accept.refuseInFlight([item.transaction_id]);
    try {
      await refuse({
        budgetId,
        transactionId: item.transaction_id,
        transferAccountId: item.transferAccountId,
      }).unwrap();
      hidden.done();
      accept.notice(t('transfer.refusedToast'));
      return true;
    } catch (err) {
      hidden.restore();
      accept.notice(apiErrorMessage(err, t('transfer.refuseFailed')));
      return false;
    }
  };

  /**
   * Skip it: the category queue's own strip, so nothing is sent until Done and
   * Undo cancels it. The row is left without a category and without a transfer
   * answer, and later runs do not ask about it again.
   */
  const skipped = async (item: TransferItem): Promise<boolean> => Promise.resolve(accept.skipTransfer(item));

  return {
    groups,
    items,
    count,
    loading: jev.isLoading,
    failed: jev.isError,
    retry: () => void jev.refetch(),
    matcher: matcher.scoped,
    matcherLoading: matcher.loading,
    matcherState: matcher,
    actions: { accept: acceptOne, refuse: refused, skip: skipped },
    acceptGroup,
    refused,
    skipped,
  };
}
