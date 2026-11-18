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
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { loadConfig } from '@/platform/config';
import { useAppSelector } from '@/store/hooks';

import {
  useCreateConnectionTokenMutation,
  useGetAccountsQuery,
  useGetConnectionsQuery,
  useGetTransactionsQuery,
  useGetUpstreamAccountsQuery,
  useRegisterConnectionMutation,
  useSyncConnectionMutation,
} from '../data/api';
import {
  buildWidgetUrl,
  classifyWidgetMessage,
  connectionStatusView,
  formatSyncStamp,
  oauthRelayUrl,
  requiresReauth,
  widgetItemId,
} from '../domain/connections';
import { connectionSparkData } from '../domain/connectionSpark';
import { formatMoney } from '../domain/format';
import { selectActiveBudgetId } from '../state/ui';
import { LinkedBy } from '../ui/LinkedBy';
import { colors, radius } from '../ui/theme';
import { GhostButton, IndigoButton } from '../ui/bits';
import * as Browser from 'expo-web-browser';
import { Sparkline } from '../ui/Sparkline';
import { ConnectionRowMenu } from './connect-bank/ConnectionRowMenu';
import { ConnectionRowButtons } from './connect-bank/ConnectionRowButtons';
import { UpstreamAccountsList } from './connect-bank/UpstreamAccountsList';
import { useConnectionActions } from './connect-bank/useConnectionActions';
import { useSyncStatus } from './connect-bank/useSyncStatus';
import { canRequestSync, syncStateView } from '../domain/syncRun';
import { ConnectBankWidget } from './ConnectBankWidget';
import { useBudgetShell } from './shell';

const STATUS_BG = { ok: colors.greenPillBg, warn: colors.yellowPillBg, bad: colors.redPillBg, off: colors.grayPillBg } as const;
const STATUS_FG = { ok: colors.greenPillFg, warn: colors.yellowPillFg, bad: colors.redFg, off: colors.grayPillFg } as const;

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
  const [createToken, tokenState] = useCreateConnectionTokenMutation();
  const [registerConnection, registerState] = useRegisterConnectionMutation();
  const [syncConnection, syncState] = useSyncConnectionMutation();
  const syncStatus = useSyncStatus();
  const actions = useConnectionActions({ budgetId });
  const { error, setError, report: syncReport, setReport, syncingId, sync, reimport, requestRemove } = actions;

  // The settings page redirects here with ?removed=1 after "Remove bank":
  // surface the report it could not show itself, then clear the param.
  useEffect(() => {
    if (removed !== '1') return;
    setReport('Bank removed — its imported history stays in your budget.');
    router.setParams({ removed: undefined });
  }, [removed, router, setReport]);

  /** Which row shows the widget inline; null = the list view. The itemId/
   *  connectionId params seed a re-auth flow: the Reconnect CTAs push here
   *  expecting the widget to open immediately. */
  const [flow, setFlow] = useState<'new' | string | null>(
    itemId && connectionId ? itemId : null,
  );
  const [widgetUrl, setWidgetUrl] = useState<string | null>(null);
  const [connectToken, setConnectToken] = useState<string | null>(null);
  const [connectionIdState, setConnectionIdState] = useState<string | null>(connectionId ?? null);

  const busy = registerState.isLoading || syncState.isLoading || actions.busy;
  const startedRef = useRef(false);

  const finish = useCallback(() => {
    setFlow(null);
    setWidgetUrl(null);
    setConnectToken(null);
  }, []);

  // One token per flow mount — the token is short-lived, frontend-only.
  useEffect(() => {
    if (flow == null || startedRef.current) return;
    startedRef.current = true;
    const run = async () => {
      setError(null);
      try {
        // A row flow passes its own itemId (re-auth); a new connection
        // leaves the item id empty so the provider creates a fresh item.
        const flowItemId = flow === 'new' ? undefined : flow;
        const token = await createToken({
          provider: loadConfig().connectionsProvider,
          ...(flowItemId ? { itemId: flowItemId } : {}),
        }).unwrap();
        if (!token.widgetUrl) throw new Error('the provider did not return a connect widget URL');
        setConnectToken(token.token);
        setWidgetUrl(buildWidgetUrl(token.widgetUrl, token.token));
      } catch (err) {
        setError(apiErrorMessage(err, 'could not start the connection flow'));
        setFlow(null);
        startedRef.current = false;
      }
    };
    void run();
  }, [createToken, flow, setError]);

  /** End the whole flow and land on the accounts screen. A replace (not
   *  back) — this screen can be entered from anywhere (menu, account edit),
   *  so back would revisit it through stale history. */
  const landOnAccounts = useCallback(() => {
    setFlow(null);
    setWidgetUrl(null);
    setConnectToken(null);
    router.replace('/accounts' as Href);
  }, [router]);

  const onWidgetMessage = useCallback(
    async (data: unknown) => {
      const outcome = classifyWidgetMessage(data);
      // OAuth connectors run in a separate window: open the system browser;
      // the relayed auth back comes over the app deep link, not here.
      if (outcome === 'oauth') {
        const url = oauthRelayUrl(data);
        if (!url) {
          setError('The bank needs its own login window — allow it to open, then try again.');
          return;
        }
        await Browser.openBrowserAsync(url);
        return;
      }
      if (outcome === 'closed') {
        finish();
        return;
      }
      if (outcome !== 'connected') return;

      // Re-auth: refresh the existing connection and return to the list.
      if (flow !== 'new' && connectionIdState) {
        if (busy) return;
        setError(null);
        try {
          await syncConnection({ id: connectionIdState, budgetId: budgetId ?? '' }).unwrap();
          finish();
        } catch (err) {
          setError(apiErrorMessage(err, 'could not refresh the reconnected bank'));
        }
        return;
      }

      if (busy) return;
      const upstreamItemId = widgetItemId(data);
      if (!upstreamItemId) {
        // Success-shaped events without an item (e.g. a mere 'connected'
        // ping) are ignored — the widget's ITEM_RESPONSE carries the id.
        return;
      }
      setError(null);
      try {
        // The server's register route settles the fresh item's accounts
        // itself (up to ~60s of retries), so one call suffices. Linking
        // those accounts to budget accounts happens per-account in the
        // account editor — this screen only registers the bank.
        const registered = await registerConnection({
          provider: loadConfig().connectionsProvider,
          itemId: upstreamItemId,
        }).unwrap();
        await syncConnection({ id: registered.connection.id, budgetId: budgetId ?? '' }).unwrap();
        landOnAccounts();
      } catch (err) {
        setError(apiErrorMessage(err, 'could not register the connected bank'));
      }
    },
    [budgetId, connectionIdState, finish, flow, busy, registerConnection, setError, syncConnection, landOnAccounts],
  );

  /** Edit (⋯) on a row: the bank's own configuration page. */
  const openSettings = useCallback(
    (id: string) => router.push(`/connection?id=${encodeURIComponent(id)}` as Href),
    [router],
  );

  /** Start the widget flow for a row (re-auth) or a new connection. */
  const startFlow = useCallback(
    async (target: 'new' | string, existingId?: string) => {
      setConnectionIdState(existingId ?? null);
      startedRef.current = false;
      setFlow(target);
    },
    [],
  );

  if (flow != null) {
    return (
      <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
        <View style={styles.head}>
          <Text style={styles.title}>{flow === 'new' ? 'Link bank account' : 'Reconnect bank'}</Text>
          <GhostButton label="Close" onPress={finish} />
        </View>

        {error ? (
          <View style={styles.banner}>
            <Text style={styles.bannerText}>{error}</Text>
          </View>
        ) : null}

        {widgetUrl && connectToken ? (
          <View style={styles.webviewWrap}>
            <ConnectBankWidget
              style={styles.webview}
              widgetUrl={widgetUrl}
              connectToken={connectToken}
              onEvent={(data) => void onWidgetMessage(data)}
              onError={setError}
            />
            {busy && !tokenState.isLoading ? (
              <View style={styles.widgetOverlay}>
                <ActivityIndicator color={colors.indigo2} />
                <Text style={styles.pendingText}>Finishing the connection…</Text>
              </View>
            ) : null}
          </View>
        ) : tokenState.isLoading ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.indigo2} />
            <Text style={styles.pendingText}>Opening the connection window…</Text>
          </View>
        ) : (
          <View style={styles.center}>
            <ActivityIndicator color={colors.indigo2} />
          </View>
        )}
      </View>
    );
  }

  const connected = connections.filter((r) => r.status === 'connected').length;
  // Disconnected rows are the graveyard of removed banks — their history
  // lives on in the ledger, but the configuration page lists live banks only.
  const visibleRows = connections.filter((r) => r.status !== 'disconnected');

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
          <Text style={styles.hint}>
            {visibleRows.length === 0
              ? 'No banks linked yet. Connect one to pull accounts and transactions.'
              : `${visibleRows.length} bank${visibleRows.length === 1 ? '' : 's'} · ${connected} connected`}
          </Text>
          <ScrollView style={styles.list}>
            {visibleRows.map((row) => {
              const syncEntry = syncStatus.entry(row.id);
              const view = syncEntry ? syncStateView(syncEntry.state) : connectionStatusView(row.status);
              const reauth = requiresReauth(row.status);
              const spark = connectionSparkData(row.id, accounts, transactions);
              // This connection's upstream accounts and their links —
              // read-only here; the account editor owns the linking choice.
              const up = upstreamRows.find((entry) => entry.connection.id === row.id);
              const linkedCount = up?.accounts?.filter((a) => a.linkedAccountId != null).length ?? 0;
              return (
                // iOS: long-press opens the system context menu over the row;
                // web/Android: the wrapper is a no-op, the kebab below opens
                // the anchored popup.
                <ConnectionRowMenu
                  key={row.id}
                  status={row.status}
                  busy={busy}
                  onSync={() => void sync(row)}
                  onReimport={() => void reimport(row)}
                  onReconnect={() => void startFlow(row.external_id, row.id)}
                  onSettings={() => openSettings(row.id)}
                  onDisconnect={() => requestRemove(row, linkedCount)}
                >
                  <Pressable
                    onPress={() => openSettings(row.id)}
                    // Web renders role=button as <button>, which can't nest the row's
                    // own Sync/Edit buttons: keep the label, drop the role there.
                    accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
                    role={Platform.OS === 'web' ? 'group' : undefined}
                    accessibilityLabel={`Open ${row.institution ?? row.provider}`}
                    style={(state) => [
                      styles.connCard,
                      styles.connCardPress,
                      ((state as { hovered?: boolean }).hovered || state.pressed) && styles.connCardHover,
                    ]}
                  >
                  <View style={styles.connRow}>
                    {/* Merged left block: avatar + name/status + last sync. */}
                    <View style={[styles.avatar, { backgroundColor: colors.indigoSoft }]}>
                      <Text style={styles.avatarText}>{(row.institution ?? row.provider).charAt(0).toUpperCase()}</Text>
                    </View>
                    <View style={styles.connMeta}>
                      <View style={styles.nameLine}>
                        <Text style={styles.connName} numberOfLines={1}>
                          {row.institution ?? row.provider}
                        </Text>
                        <View style={[styles.statusPill, { backgroundColor: STATUS_BG[view.tone] }]}>
                          <Text style={[styles.statusText, { color: STATUS_FG[view.tone] }]}>{view.label}</Text>
                        </View>
                      </View>
                      <Text style={styles.connSub} numberOfLines={1}>
                        {reauth
                          ? `Reconnect to refresh credentials · ${row.environment === 'sandbox' ? 'sandbox' : 'added ' + formatSyncStamp(row.created_at)}`
                          : `Last sync: ${row.last_synced_at ? formatSyncStamp(row.last_synced_at) : 'added ' + formatSyncStamp(row.created_at)}${row.environment === 'sandbox' ? ' · sandbox' : ''}`}
                      </Text>
                      {row.status_message && row.status !== 'connected' ? (
                        <Text style={styles.connSub} numberOfLines={2}>
                          {row.status_message}
                        </Text>
                      ) : null}
                      <LinkedBy linkedBy={row.linked_by} />
                    </View>
                    {/* Activity sparkline + balance only where a link exists. */}
                    {spark ? (
                      <>
                        {/* Phone rows are tight: the sparkline yields to the row buttons. */}
                        {width >= 700 ? (
                          <Sparkline points={spark.series} width={96} height={24} fill={colors.indigo2} />
                        ) : null}
                        <Text style={styles.connBalance}>{formatMoney(spark.balanceCents)}</Text>
                      </>
                    ) : null}
                    <ConnectionRowButtons
                      institution={row.institution ?? row.provider}
                      canSync={canRequestSync(row.status) && !busy}
                      syncing={syncingId === row.id}
                      onSync={() => void sync(row)}
                      onEdit={() => openSettings(row.id)}
                    />
                  </View>
                  {up == null ? null : <UpstreamAccountsList up={up} accounts={accounts} />}
                  </Pressable>
                </ConnectionRowMenu>
              );
            })}
          </ScrollView>
          <IndigoButton
            label={tokenState.isLoading || busy ? 'Working…' : 'Connect another bank'}
            style={styles.connectBtn}
            onPress={tokenState.isLoading || busy ? undefined : () => void startFlow('new')}
          />
        </>
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg, padding: 16, gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800' },
  hint: { color: colors.muted, fontSize: 13 },
  banner: {
    backgroundColor: colors.redPillBg,
    borderColor: colors.border2,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 10,
  },
  bannerText: { color: colors.redFg, fontSize: 13 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10 },
  pendingText: { color: colors.muted, fontSize: 13 },
  list: { flex: 1 },
  connCard: {
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    marginBottom: 8,
    overflow: 'hidden',
    backgroundColor: colors.card,
  },
  connCardPress: { cursor: 'pointer' } as object,
  connCardHover: { backgroundColor: colors.hover },
  connRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
    paddingHorizontal: 12,
  },
  connMeta: { flex: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', gap: 2 },
  connName: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  connSub: { color: colors.muted, fontSize: 12 },
  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  statusText: { fontSize: 11, fontWeight: '600' },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.indigo3, fontSize: 15, fontWeight: '700' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  connBalance: { color: colors.text, fontSize: 14, fontWeight: '700', marginLeft: 'auto', flexShrink: 0 },
  reportBanner: {
    backgroundColor: colors.greenPillBg,
    borderWidth: 1,
    borderRadius: radius.sm,
    padding: 10,
  },
  reportText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  connectBtn: { marginBottom: 4 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    marginBottom: 8,
  },
  accountMeta: { flex: 1, gap: 2 },
  accountName: { color: colors.text, fontSize: 14, fontWeight: '600' },
  accountSub: { color: colors.muted, fontSize: 12 },
  accountBalance: { color: colors.text, fontSize: 14, fontWeight: '700', marginLeft: 8 },
  webview: { flex: 1, borderRadius: radius.r, overflow: 'hidden', backgroundColor: colors.card },
  webviewWrap: { flex: 1 },
  widgetOverlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    backgroundColor: colors.card,
  },
});
