/**
 * Wiring of the Categorize run card: the run status (polled while a run is in
 * flight, so progress is live), the start mutation and the confirmation step.
 * Rules live in run.logic.ts.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useGetCategorizeRunQuery, useStartCategorizeRunMutation } from '@/budget/data/api';

import { runCountChoice, runCountCue, runCountField, runPhase, runPollMs } from './run.logic';

/** What the effect watched last: one run of one budget, in flight or settled. */
type Watched = { runId: string; settled: boolean };

/**
 * @param onFinished called once each time a run stops being in flight while
 *   this page is mounted, so the page reloads the queue the run wrote
 *   suggestions into. A run already settled when the page opens reloads
 *   nothing: its suggestions are already in the queue it reads.
 */
export function useCategorizeRun({ budgetId, onFinished }: { budgetId: string | null | undefined; onFinished: () => void }) {
  const [confirming, setConfirming] = useState(false);
  // The count field's text. Empty means "everything waiting". The field is
  // cleared every time the confirmation opens: a size typed for the last
  // question is not an answer to this one.
  const [countText, setCountText] = useState('');
  // Poll only while the run can still change on its own. The interval comes
  // from the CURRENT read (state), never from a value the render cannot see:
  // a ref of the previous render would leave the first queued read unpolled.
  const [pollMs, setPollMs] = useState(0);
  const status = useGetCategorizeRunQuery(
    { budgetId: budgetId ?? '' },
    { skip: !budgetId, pollingInterval: pollMs },
  );
  useEffect(() => {
    setPollMs(runPollMs(status.data));
  }, [status.data]);

  const [startRun, startState] = useStartCategorizeRunMutation();
  const phase = runPhase(status.data);

  // The queue changes only when a run that WAS in flight settles here.
  const watched = useRef<Watched | null>(null);
  const run = status.data?.run ?? null;
  useEffect(() => {
    if (!run) return;
    const settled = run.state !== 'queued' && run.state !== 'running';
    const before = watched.current;
    watched.current = { runId: run.run_id, settled };
    if (settled && before?.runId === run.run_id && !before.settled) onFinished();
  }, [run, onFinished]);

  const refetchStatus = status.refetch;
  const ask = useCallback(() => {
    if (!status.data?.configured) return;
    setCountText('');
    setConfirming(true);
    // The question must name the count the server has NOW: rows arrive from the
    // register and from other clients, and a number from an old read would
    // promise a different run than the one Start sends.
    void refetchStatus();
  }, [status.data?.configured, refetchStatus]);
  const cancelAsk = useCallback(() => setConfirming(false), []);
  // The confirmation shows its own numbers only once the fresh status is here.
  const checking = confirming && status.isFetching;
  const countField = runCountField(countText, status.data?.candidates ?? 0);
  const start = useCallback(() => {
    if (!budgetId || countField.kind === 'invalid') return;
    setConfirming(false);
    void startRun({ budgetId, count: runCountChoice(countField) })
      .unwrap()
      .catch(() => undefined);
  }, [budgetId, countField, startRun]);

  return {
    status: status.data,
    isLoading: status.isLoading,
    isError: status.isError,
    retry: () => void status.refetch(),
    phase,
    confirming,
    checking,
    countText,
    setCountText,
    countField,
    countChoice: runCountChoice(countField),
    countCue: runCountCue(countField),
    ask,
    cancelAsk,
    start,
    starting: startState.isLoading,
    startError: startState.error,
  } as const;
}

export type CategorizeRunState = ReturnType<typeof useCategorizeRun>;
