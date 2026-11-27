/**
 * Wiring of the Categorize page: the queue page, settings threshold and the
 * accept flow. The views receive plain data and callbacks; this hook owns
 * effects, mutations and the optimistic state.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useMemo, useState } from 'react';

import {
  budgetApi,
  categorizePageTags,
  useGetCategorizeQueueQuery,
  useGetCategorizeSettingsQuery,
  useSetCategorizeSettingsMutation,
  type CategorizeQueueRow,
} from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppDispatch, useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { useMoneyFormat } from '@/ui/moneyFormat';

import { hiddenIdSet, pendingSkips, queueLeaving, visibleRows } from './accept.logic';
import { t } from './i18n';
import { thresholdReloading } from './page.logic';
import { bundleView, countsWithoutLeaving, queueSubtitle, type BundleView } from './queue.logic';
import { useCategorizeAccept } from './useCategorizeAccept';
import { useCategorizeTransfers } from './useCategorizeTransfers';
import { useOneByOne } from './useOneByOne';

/** The page holds one page of rows; the bundles cover the whole queue. */
const QUEUE_PAGE = 200;

export type CategorizeViewMode = 'bundles' | 'one';

export function useCategorizePage(rootRef: { current: unknown }) {
  const budgetId = useAppSelector(selectActiveBudgetId);
  const format = useMoneyFormat();
  const dispatch = useAppDispatch();
  const scope = budgetId ? { budgetId } : skipToken;

  const queue = useGetCategorizeQueueQuery(budgetId ? { budgetId, limit: QUEUE_PAGE } : skipToken);
  const settings = useGetCategorizeSettingsQuery(scope);
  const [setSettings] = useSetCategorizeSettingsMutation();

  // One write refreshes every list the page and its badges read, so a finished
  // run or a retry never leaves Transfers, the matcher or the run card stale.
  const refresh = () => {
    if (budgetId) dispatch(budgetApi.util.invalidateTags(categorizePageTags(budgetId)));
  };

  const [view, setView] = useState<CategorizeViewMode>('bundles');
  const [threshold, setThreshold] = useState(0.8);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [thresholdStamp, setThresholdStamp] = useState<number | null>(null);

  /**
   * "Show all" in the No suggestion group: the page holds ONE read of
   * `QUEUE_PAGE` rows while the counts cover the whole queue, so on a long
   * queue the rest is read page by page here. A queue re-read (any answer, a
   * threshold change) drops what grew: the fresh page is newer than it.
   */
  const [grownRows, setGrownRows] = useState<CategorizeQueueRow[] | null>(null);
  const [growing, setGrowing] = useState(false);
  const queueStamp = queue.fulfilledTimeStamp ?? 0;
  useEffect(() => {
    setGrownRows(null);
  }, [queueStamp, budgetId]);

  const loadAllRows = async () => {
    const first = queue.data;
    if (!budgetId || !first || growing) return;
    setGrowing(true);
    try {
      const rows = [...first.rows];
      let manual = rows.filter((row) => row.suggestions.length === 0).length;
      // Only the rows this group is short of: a queue of thousands is not read
      // to the end to fill a group that is already complete.
      const manualTarget = Math.max(0, first.counts.left_to_categorize - first.counts.above_threshold);
      while (rows.length < first.counts.left_to_categorize && manual < manualTarget) {
        const request = dispatch(
          budgetApi.endpoints.getCategorizeQueue.initiate({
            budgetId,
            limit: QUEUE_PAGE,
            offset: rows.length,
          }),
        );
        try {
          const page = await request.unwrap();
          if (page.rows.length === 0) break;
          rows.push(...page.rows);
          manual += page.rows.filter((row) => row.suggestions.length === 0).length;
        } finally {
          // A read of its own page of the queue: nothing on screen watches it
          // through the cache, so its subscription ends here.
          request.unsubscribe();
        }
      }
      setGrownRows(rows);
    } catch (err) {
      setThresholdError(apiErrorMessage(err, t('noSuggestion.loadFailed')));
    } finally {
      setGrowing(false);
    }
  };

  const queueRowIds = useMemo(() => queue.data?.rows.map((row) => row.transaction_id) ?? [], [queue.data]);
  const accept = useCategorizeAccept({
    budgetId,
    formatMoney: format.formatMoney,
    queueRefetch: () => void queue.refetch(),
    queueUpdatedAt: queue.fulfilledTimeStamp ?? 0,
    queueRowIds,
    queueSize: queue.data?.counts.left_to_categorize ?? 0,
  });

  // Jev's transfer answers and the matcher's pairs: their own lists, answered
  // through the same accept flow (same toast and Undo) plus refuse/skip.
  const transfers = useCategorizeTransfers({ budgetId, accept });

  const serverThreshold = settings.data?.confidence_threshold;
  useEffect(() => {
    if (serverThreshold !== undefined) setThreshold(serverThreshold);
  }, [serverThreshold]);

  const commitThreshold = async (next: number) => {
    if (!budgetId || savingThreshold) return;
    setThreshold(next);
    setThresholdError(null);
    setSavingThreshold(true);
    try {
      const readAt = queue.fulfilledTimeStamp ?? 0;
      await setSettings({ budgetId, confidenceThreshold: next }).unwrap();
      setThresholdStamp(readAt);
    } catch (err) {
      setThreshold(serverThreshold ?? 0.8);
      setThresholdError(apiErrorMessage(err, t('error.threshold')));
    } finally {
      setSavingThreshold(false);
    }
  };

  // The rows waiting in the "Leaving uncategorized" strip are still in the queue
  // as far as the server knows; every count the page shows leaves them out, and
  // only the ones the queue counts (a Jev transfer answer is never in it).
  const stack = accept.state.stack;
  const leaving = useMemo(() => queueLeaving(pendingSkips({ stack })).map((entry) => entry.meta), [stack]);
  // The rows the page shows: the one read it opens with, or every page the No
  // suggestion group asked for.
  const queueData = useMemo(
    () => (queue.data ? { ...queue.data, rows: grownRows ?? queue.data.rows } : undefined),
    [queue.data, grownRows],
  );
  const viewModel: BundleView | null = useMemo(
    () => (queueData ? bundleView(queueData, leaving) : null),
    [queueData, leaving],
  );
  const hidden = useMemo(() => hiddenIdSet(accept.state), [accept.state]);
  const manualRows = useMemo(
    () => (viewModel ? visibleRows(viewModel.manualRows, hidden) : []),
    [viewModel, hidden],
  );
  const visibleQueueRows = useMemo(
    () => (queueData ? visibleRows(queueData.rows, hidden) : []),
    [queueData, hidden],
  );

  const counts = queue.data?.counts;
  const shownCounts = counts ? countsWithoutLeaving(counts, leaving) : undefined;
  // The old bundles and rows were cut at the old threshold: until the read that
  // follows the change lands they are shown as updating and cannot be acted on.
  const reloading = thresholdReloading({
    saving: savingThreshold,
    stamp: thresholdStamp,
    fulfilledAt: queue.fulfilledTimeStamp ?? 0,
    failed: queue.isError,
  });
  useEffect(() => {
    if (!reloading && thresholdStamp !== null) setThresholdStamp(null);
  }, [reloading, thresholdStamp]);
  const oneByOne = useOneByOne({
    enabled: !reloading,
    rowKeys: view === 'one',
    rootRef,
    rows: visibleQueueRows,
    pageRows: queueData?.rows ?? [],
    transfers: transfers.items,
    /** Jev's answers as the read counts them: the counter adds what the header adds. */
    answerCount: transfers.count,
    counts,
    accept,
    transferActions: transfers.actions,
  });
  const error = thresholdError ?? accept.state.error;

  return {
    budgetId,
    view,
    setView,
    queue: {
      data: queueData,
      isLoading: queue.isLoading,
      isError: queue.isError,
      subtitle: shownCounts ? queueSubtitle(shownCounts, transfers.count) : null,
      counts: shownCounts,
    },
    /** Read the rest of a long queue, for the No suggestion group. */
    loadAllRows: () => void loadAllRows(),
    growing,
    viewModel,
    manualRows,
    hiddenIds: hidden,
    visibleQueueRows,
    oneByOne,
    threshold,
    reloading,
    savingThreshold,
    commitThreshold,
    accept,
    transfers,
    /** Undo the last action and bring its rows back into the One by one lines. */
    undoLast: oneByOne.undo,
    cancelSkip: oneByOne.cancelSkip,
    error,
    dismissError: () => {
      setThresholdError(null);
      accept.dismissError();
    },
    /**
     * Re-read everything the page shows — queue and counts, Jev's answers, the
     * matcher's pairs and the run card — after a run finishes or an error.
     */
    refresh,
  };
}
