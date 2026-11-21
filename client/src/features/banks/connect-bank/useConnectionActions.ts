/**
 * Sync / re-import / remove handlers + their report and error state, shared by
 * the Linked banks list and the per-bank settings page.
 */

import { useCallback, useEffect, useState } from 'react';
import { Alert } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { apiErrorMessage } from '@/platform/api/baseQuery';

import { useDisconnectConnectionMutation } from '@/budget/data/api';
import type { ConnectionJson } from '@/budget/data/connections';
import { removeConfirmation } from './connectionRowMenuShared';
import { t } from './i18n';
import { useSyncRunner } from './useSyncRunner';

export function useConnectionActions({
  budgetId,
  onRemoved,
}: {
  budgetId: string | null | undefined;
  /** Called after a successful removal (e.g. navigate back to the list). */
  onRemoved?: () => void;
}) {
  const runner = useSyncRunner(budgetId);
  const [disconnectConnection, disconnectState] = useDisconnectConnectionMutation();

  const [error, setError] = useState<string | null>(null);
  /** Post-action mini-report: "added 2 · updated 1 · removed 1" — auto-dismisses. */
  const [report, setReport] = useState<string | null>(null);
  /** Connection currently syncing (Sync button spinner). */
  const [syncingId, setSyncingId] = useState<string | null>(null);
  /** Connection whose re-import is awaiting its background run. */
  const [reimportingId, setReimportingId] = useState<string | null>(null);
  const busy = runner.requesting || syncingId != null || reimportingId != null || disconnectState.isLoading;

  useEffect(() => {
    if (!report) return;
    const id = setTimeout(() => setReport(null), 4000);
    return () => clearTimeout(id);
  }, [report]);

  /** Sync/re-import run in the background: enqueue, then follow the run until it ends. */
  const follow = useCallback(
    async (row: ConnectionJson, mode: 'sync' | 'reimport', fallback: string) => {
      if (!budgetId) return;
      setError(null);
      (mode === 'sync' ? setSyncingId : setReimportingId)(row.id);
      try {
        const outcome = await runner.run(row.id, mode);
        (outcome.kind === 'error' ? setError : setReport)(outcome.text);
      } catch (err) {
        setError(apiErrorMessage(err, fallback));
      } finally {
        (mode === 'sync' ? setSyncingId : setReimportingId)(null);
      }
    },
    [budgetId, runner],
  );

  const sync = useCallback((row: ConnectionJson) => follow(row, 'sync', t('actions.syncFailed')), [follow]);

  /** Watermark-ignoring history re-pull (deduped) — back-fills accounts that
   *  were linked after the connection first synced. Safe to repeat. */
  const reimport = useCallback(
    (row: ConnectionJson) => follow(row, 'reimport', t('actions.reimportFailed')),
    [follow],
  );

  const remove = useCallback(
    async (row: ConnectionJson) => {
      setError(null);
      try {
        await disconnectConnection({ id: row.id, budgetId: budgetId ?? '' }).unwrap();
        // Say what happened: the row disappears from the list, its imported
        // history stays on the linked budget accounts.
        setReport(t('actions.removed'));
        onRemoved?.();
      } catch (err) {
        setError(apiErrorMessage(err, t('actions.removeFailed')));
      }
    },
    [budgetId, disconnectConnection, onRemoved],
  );

  /** Remove with the linked-account guard: explain the block, else confirm first. */
  const requestRemove = useCallback(
    (row: ConnectionJson, linkedCount: number) => {
      const c = removeConfirmation(row.institution ?? row.provider, linkedCount);
      if (process.env.EXPO_OS === 'web') {
        if (c.kind === 'blocked') return setError(c.message);
        // RN Alert has no web implementation.
        if (window.confirm(`${c.title}\n${c.message}`)) void remove(row);
        return;
      }
      if (c.kind === 'blocked') return Alert.alert(c.title, c.message);
      Alert.alert(c.title, c.message, [
        { text: tCommon('cancel'), style: 'cancel' },
        { text: tCommon('remove'), style: 'destructive', onPress: () => void remove(row) },
      ]);
    },
    [remove],
  );

  return { busy, syncingId, reimportingId, error, setError, report, setReport, sync, reimport, requestRemove };
}
