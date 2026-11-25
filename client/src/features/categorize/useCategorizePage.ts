/**
 * Wiring of the Categorize page: the queue page, settings threshold, run
 * status (polled only while a run is active) and the accept flow. The views
 * receive plain data and callbacks; this hook owns effects, mutations and the
 * optimistic state. Run completion refreshes the queue once, so suggestions
 * appear without waiting for the next revision poll.
 */

import { skipToken } from '@reduxjs/toolkit/query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  budgetApi,
  useGetCategorizeQueueQuery,
  useGetCategorizeRunStatusQuery,
  useGetCategorizeSettingsQuery,
  useSetCategorizeSettingsMutation,
  useStartCategorizeRunMutation,
} from '@/budget/data/api';
import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppDispatch, useAppSelector } from '@/state/hooks';
import { selectActiveBudgetId } from '@/state/ui';
import { useMoneyFormat } from '@/ui/moneyFormat';

import { hiddenIdSet, pendingSkips, visibleRows } from './accept.logic';
import { t } from './i18n';
import { aiReasonMessage, runHeaderView, thresholdReloading, type RunHeaderView } from './page.logic';
import { bundleView, countsWithoutLeaving, queueSubtitle, type BundleView } from './queue.logic';
import { useCategorizeAccept } from './useCategorizeAccept';
import { useOneByOne } from './useOneByOne';

/** The page holds one page of rows; the bundles cover the whole queue. */
const QUEUE_PAGE = 200;
const RUN_POLL_MS = 2000;

export type CategorizeViewMode = 'bundles' | 'one';

export function useCategorizePage(rootRef: { current: unknown }) {
  const budgetId = useAppSelector(selectActiveBudgetId);
  const dispatch = useAppDispatch();
  const format = useMoneyFormat();
  const scope = budgetId ? { budgetId } : skipToken;

  const queue = useGetCategorizeQueueQuery(budgetId ? { budgetId, limit: QUEUE_PAGE } : skipToken);
  const settings = useGetCategorizeSettingsQuery(scope);
  const [pollMs, setPollMs] = useState(0);
  const status = useGetCategorizeRunStatusQuery(scope, { pollingInterval: pollMs });
  const [setSettings] = useSetCategorizeSettingsMutation();
  const [startRunMutation] = useStartCategorizeRunMutation();

  const [view, setView] = useState<CategorizeViewMode>('bundles');
  const [threshold, setThreshold] = useState(0.8);
  const [savingThreshold, setSavingThreshold] = useState(false);
  const [thresholdError, setThresholdError] = useState<string | null>(null);
  /** A modal (the Run confirmation) is open: the page's key shortcuts must not act behind it. */
  const [modalOpen, setModalOpen] = useState(false);
  const [thresholdStamp, setThresholdStamp] = useState<number | null>(null);
  const [runStarting, setRunStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const queueRowIds = useMemo(() => queue.data?.rows.map((row) => row.transaction_id) ?? [], [queue.data]);
  const accept = useCategorizeAccept({
    budgetId,
    formatMoney: format.formatMoney,
    queueRefetch: () => void queue.refetch(),
    queueUpdatedAt: queue.fulfilledTimeStamp ?? 0,
    queueRowIds,
    queueSize: queue.data?.counts.left_to_categorize ?? 0,
  });

  const active = status.data?.active;
  useEffect(() => {
    setPollMs(active ? RUN_POLL_MS : 0);
  }, [active]);

  // A run that just finished produced suggestions: refresh the queue once.
  const finishedId = status.data?.last_finished?.id ?? null;
  const seenFinished = useRef<string | null>(null);
  const sawActive = useRef(false);
  useEffect(() => {
    if (!budgetId) return;
    if (active) {
      sawActive.current = true;
      return;
    }
    const changed = finishedId !== null && finishedId !== seenFinished.current;
    if (finishedId && (sawActive.current || (seenFinished.current !== null && changed))) {
      dispatch(budgetApi.util.invalidateTags([{ type: 'Categorize', id: budgetId }]));
    }
    sawActive.current = false;
    seenFinished.current = finishedId;
  }, [active, budgetId, dispatch, finishedId]);

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

  const startRun = async () => {
    if (!budgetId || runStarting || active) return;
    setRunStarting(true);
    setRunError(null);
    try {
      await startRunMutation({ budgetId }).unwrap();
    } catch (err) {
      setRunError(apiErrorMessage(err, t('run.startedFailed')));
    } finally {
      setRunStarting(false);
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
    enabled: !reloading && !modalOpen,
    rowKeys: view === 'one',
    rootRef,
    rows: visibleQueueRows,
    pageRows: queue.data?.rows ?? [],
    counts,
    accept,
  });
  const runView: RunHeaderView | null = status.data
    ? runHeaderView(
        status.data,
        counts ?? { left_to_categorize: 0, not_classified: 0 },
        format,
      )
    : null;
  const aiAvailable = status.data?.ai.available ?? false;
  /** Why classification is off, whatever else the header shows (an active run wins there). */
  const aiReason = aiReasonMessage(status.data?.ai.reason ?? null);
  const error = thresholdError ?? runError ?? accept.state.error;

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
    setModalOpen,
    savingThreshold,
    commitThreshold,
    runView,
    aiAvailable,
    aiReason,
    runStarting,
    startRun,
    statusLoaded: status.data !== undefined,
    accept,
    /** Undo the last action and bring its rows back into the One by one lines. */
    undoLast: oneByOne.undo,
    cancelSkip: oneByOne.cancelSkip,
    error,
    dismissError: () => {
      setThresholdError(null);
      setRunError(null);
      accept.dismissError();
    },
    retryQueue: () => void queue.refetch(),
  };
}
