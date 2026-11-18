/**
 * Bank Connections — the linked-banks hub. Lists every Pluggy connection the
 * user has made (the DB is one row per bank link: many connections per user),
 * with sync/reconnect/disconnect actions per row, the connect-widget flow
 * that adds a new connection, and a read-only list of each connection's
 * upstream accounts with their budget-account links. Linking is 1:1 and is
 * edited per account in the account editor — never here.
 *
 * Entry points: the settings menu ("Link bank account") and the account
 * editor's add-new-bank entry. Re-auth reuses the flow with the connection's
 * item id so the provider reconnects the existing credentials instead of
 * creating a duplicate.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { skipToken } from '@reduxjs/toolkit/query';
import { useCallback, useEffect } from 'react';
import { ActivityIndicator, ScrollView, Text, useWindowDimensions, View } from 'react-native';

import { useAppSelector } from '@/state/hooks';

import {
  useGetAccountsQuery,
  useGetConnectionsQuery,
  useGetTransactionsQuery,
  useGetUpstreamAccountsQuery,
} from '@/budget/data/api';
import { selectActiveBudgetId } from '@/state/ui';
import { colors } from '@/ui/theme';
import { GhostButton, IndigoButton } from '@/ui/bits';
import { banksHint, visibleConnections } from './connect-bank/connectBank.logic';
import { ConnectFlowView } from './connect-bank/ConnectFlowView';
import { ConnectionRow } from './connect-bank/ConnectionRow';
import { styles } from './connect-bank/screenStyles';
import { useConnectFlow } from './connect-bank/useConnectFlow';
import { useConnectionActions } from './connect-bank/useConnectionActions';
import { useSyncStatus } from './connect-bank/useSyncStatus';
import { useBudgetShell } from '@/shell/context';

export function ConnectBankScreen() {
  const router = useRouter();
  const shell = useBudgetShell();
  const { width } = useWindowDimensions();
  // itemId/connectionId: set when re-authenticating an existing connection
  // (Reconnect CTA). Bank→account linking lives in the account editor only.
  const { itemId, connectionId, removed } = useLocalSearchParams<{
    itemId?: string;
    connectionId?: string;
    removed?: string;
  }>();
  // For cache-tag invalidation of the affected budget's accounts/transactions.
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));

  const connectionsQuery = useGetConnectionsQuery();
  const connections = connectionsQuery.data ?? [];
  // Linked accounts + their transactions power each row's activity sparkline
  // and balance column; they subscribe only when a budget is active.
  const accountsQuery = useGetAccountsQuery(budgetId ? { budgetId } : skipToken);
  const transactionsQuery = useGetTransactionsQuery(budgetId ? { budgetId } : skipToken);
  const accounts = accountsQuery.data ?? [];
  const transactions = transactionsQuery.data ?? [];
  // Each connection's upstream accounts and their link targets feed the
  // read-only accounts list under every row.
  const upstreamQuery = useGetUpstreamAccountsQuery(undefined);
  const upstreamRows = upstreamQuery.data ?? [];
  const syncStatus = useSyncStatus();
  const actions = useConnectionActions({ budgetId });
  const { error, setError, report: syncReport, setReport, syncingId, sync, reimport, requestRemove } = actions;
  const connect = useConnectFlow({ budgetId, itemId, connectionId, actionsBusy: actions.busy, setError });
  const { flow, busy, tokenLoading, landOnAccounts, startFlow } = connect;

  // The settings page redirects here with ?removed=1 after "Remove bank":
  // surface the report it could not show itself, then clear the param.
  useEffect(() => {
    if (removed !== '1') return;
    setReport('Bank removed — its imported history stays in your budget.');
    router.setParams({ removed: undefined });
  }, [removed, router, setReport]);

  /** Edit (⋯) on a row: the bank's own configuration page. */
  const openSettings = useCallback(
    (id: string) => router.push(`/connection?id=${encodeURIComponent(id)}` as Href),
    [router],
  );

  if (flow != null) {
    return (
      <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
        <ConnectFlowView connect={connect} error={error} setError={setError} />
      </View>
    );
  }

  // Disconnected rows are the graveyard of removed banks — their history
  // lives on in the ledger, but the configuration page lists live banks only.
  const visibleRows = visibleConnections(connections);

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <View style={styles.head}>
        <Text style={styles.title}>Linked banks</Text>
        {/* Close affordance in every phase (back-nav requirement). */}
        <GhostButton label="Close" onPress={() => landOnAccounts()} />
      </View>

      {error ? (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{error}</Text>
        </View>
      ) : null}

      {/* Non-blocking: the app keeps working while the scheduler is down. */}
      {syncStatus.banner ? (
        <View style={styles.reportBanner}>
          <Text style={styles.reportText}>{syncStatus.banner}</Text>
        </View>
      ) : null}

      {/* Post-sync mini-report — drops from the top, dismisses itself. */}
      {syncReport ? (
        <View style={[styles.reportBanner, { borderColor: colors.greenPillBg }]}>
          <Text style={styles.reportText}>{syncReport}</Text>
        </View>
      ) : null}

      {connectionsQuery.isLoading ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
        </View>
      ) : (
        <>
          <Text style={styles.hint}>{banksHint(connections)}</Text>
          <ScrollView style={styles.list}>
            {visibleRows.map((row) => (
              <ConnectionRow
                key={row.id}
                row={row}
                syncEntry={syncStatus.entry(row.id)}
                accounts={accounts}
                transactions={transactions}
                up={upstreamRows.find((entry) => entry.connection.id === row.id)}
                busy={busy}
                syncing={syncingId === row.id}
                wide={width >= 700}
                onSync={() => void sync(row)}
                onReimport={() => void reimport(row)}
                onReconnect={() => void startFlow(row.external_id, row.id)}
                onSettings={() => openSettings(row.id)}
                onDisconnect={(linkedCount) => requestRemove(row, linkedCount)}
              />
            ))}
          </ScrollView>
          <IndigoButton
            label={tokenLoading || busy ? 'Working…' : 'Connect another bank'}
            style={styles.connectBtn}
            onPress={tokenLoading || busy ? undefined : () => void startFlow('new')}
          />
        </>
      )}

    </View>
  );
}
