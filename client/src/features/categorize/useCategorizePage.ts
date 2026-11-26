/**
 * Wiring of the Categorize page: the queue page, settings threshold and the
 * accept flow. The views receive plain data and callbacks; this hook owns
 * effects, mutations and the optimistic state.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useMemo, useState } from 'react';

import {
  useGetCategorizeQueueQuery,
  useGetCategorizeSettingsQuery,
  useSetCategorizeSettingsMutation,
} from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { useMoneyFormat } from '@/ui/moneyFormat';

import { hiddenIdSet, pendingSkips, visibleRows } from './accept.logic';
import { t } from './i18n';
import { thresholdReloading } from './page.logic';
import { bundleView, countsWithoutLeaving, queueSubtitle, type BundleView } from './queue.logic';
import { useCategorizeAccept } from './useCategorizeAccept';
import { useOneByOne } from './useOneByOne';

/** The page holds one page of rows; the bundles cover the whole queue. */
const QUEUE_PAGE = 200;

export type CategorizeViewMode = 'bundles' | 'one';

export function useCategorizePage(rootRef: { current: unknown }) {
  const budgetId = useAppSelector(selectActiveBudgetId);
  const format = useMoneyFormat();
  const scope = budgetId ? { budgetId } : skipToken;

  const queue = useGetCategorizeQueueQuery(budgetId ? { budgetId, limit: QUEUE_PAGE } : skipToken);
  const settings = useGetCategorizeSettingsQuery(scope);
  const [setSettings] = useSetCategorizeSettingsMutation();

  const [view, setView] = useState<CategorizeViewMode>('bundles');
  const [threshold, setThreshold] = useState(0.8);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  const [thresholdStamp, setThresholdStamp] = useState<number | null>(null);

  const queueRowIds = useMemo(() => queue.data?.rows.map((row) => row.transaction_id) ?? [], [queue.data]);
  const accept = useCategorizeAccept({
    budgetId,
    formatMoney: format.formatMoney,
    queueRefetch: () => void queue.refetch(),
    queueUpdatedAt: queue.fulfilledTimeStamp ?? 0,
    queueRowIds,
    queueSize: queue.data?.counts.left_to_categorize ?? 0,
  });

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
  // as far as the server knows; every count the page shows leaves them out.
  const stack = accept.state.stack;
  const leaving = useMemo(() => pendingSkips({ stack }).map((entry) => entry.meta), [stack]);
  const viewModel: BundleView | null = useMemo(
    () => (queue.data ? bundleView(queue.data, leaving) : null),
    [queue.data, leaving],
  );
  const hidden = useMemo(() => hiddenIdSet(accept.state), [accept.state]);
  const manualRows = useMemo(
    () => (viewModel ? visibleRows(viewModel.manualRows, hidden) : []),
    [viewModel, hidden],
  );
  const visibleQueueRows = useMemo(
    () => (queue.data ? visibleRows(queue.data.rows, hidden) : []),
    [queue.data, hidden],
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
    pageRows: queue.data?.rows ?? [],
    counts,
    accept,
  });
  const error = thresholdError ?? accept.state.error;

  return {
    budgetId,
    view,
    setView,
    queue: {
      data: queue.data,
      isLoading: queue.isLoading,
      isError: queue.isError,
      subtitle: shownCounts ? queueSubtitle(shownCounts) : null,
      counts: shownCounts,
    },
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
    /** Undo the last action and bring its rows back into the One by one lines. */
    undoLast: oneByOne.undo,
    cancelSkip: oneByOne.cancelSkip,
    error,
    dismissError: () => {
      setThresholdError(null);
      accept.dismissError();
    },
    retryQueue: () => void queue.refetch(),
  };
}
