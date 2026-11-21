/**
 * The bank's page (`/connection-settings?id=<connectionId>`, opened from
 * a Linked banks row): header (name, status, last sync, Sync now, Settings),
 * an Overview tab with one summary card per linked account, and ONE TAB PER
 * LINKED ACCOUNT listing only that account's imported transactions (lazy,
 * keyset-paginated). Settings (sync window, re-import, reconnect, remove) live
 * behind the Settings action: a right-hand panel on desktop, a sheet elsewhere.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import type { Href } from 'expo-router';
import { skipToken } from '@reduxjs/toolkit/query';
import { useCallback, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { apiErrorMessage } from '@/platform/api/baseQuery';
import { useAppSelector } from '@/state/hooks';

import {
  useGetAccountsQuery,
  useGetConnectionSettingsQuery,
  useGetConnectionSummaryQuery,
  useGetConnectionsQuery,
  useGetTransactionsQuery,
  useGetUpstreamAccountsQuery,
  useUpdateConnectionSyncWindowMutation,
} from '@/budget/data/api';
import { bankDisplayName } from './model/bankPage';
import { connectionStatusView, formatSyncStamp, humanizeConnectionError } from './model/connections';
import { selectActiveBudgetId } from '@/state/ui';
import { colors, radius } from '@/ui/theme';
import { GhostButton, IndigoButton, OverlaySheet } from '@/ui/bits';
import { AccountTab } from './bank/AccountTab';
import { OverviewTab } from './bank/OverviewTab';
import { SettingsPanel } from './bank/SettingsPanel';
import { PausedNotice } from './keys/PausedNotice';
import { PLUGGY_KEYS_ROUTE } from './keys/pluggyKeys.logic';
import { useConnectionActions } from './connect-bank/useConnectionActions';
import { useSyncStatus } from './connect-bank/useSyncStatus';
import { storedServerMessage } from './model/serverMessage';
import { canRequestSync, syncStateView } from './model/syncRun';
import { useBudgetShell } from '@/shell/context';
import { t } from './i18n';

const STATUS_BG = { ok: colors.greenPillBg, warn: colors.yellowPillBg, bad: colors.redPillBg, off: colors.grayPillBg } as const;
const STATUS_FG = { ok: colors.greenPillFg, warn: colors.yellowPillFg, bad: colors.redFg, off: colors.grayPillFg } as const;

const LIST_HREF = '/connect-bank' as Href;
const REMOVED_HREF = '/connect-bank?removed=1' as Href;
const OVERVIEW = 'overview';

export function ConnectionSettingsScreen() {
  const router = useRouter();
  const shell = useBudgetShell();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const budgetId = useAppSelector((s) => selectActiveBudgetId(s));

  const connectionsQuery = useGetConnectionsQuery();
  const connection = (connectionsQuery.data ?? []).find((c) => c.id === id) ?? null;
  const live = connection != null && connection.status !== 'disconnected';
  const summaryQuery = useGetConnectionSummaryQuery(id && live ? { id } : skipToken);
  const upstreamQuery = useGetUpstreamAccountsQuery(undefined);
  const up = (upstreamQuery.data ?? []).find((entry) => entry.connection.id === id);
  // Link count for the remove guard + the Overview's balance/activity cards.
  const accountsQuery = useGetAccountsQuery(budgetId ? { budgetId } : skipToken);
  const transactionsQuery = useGetTransactionsQuery(budgetId ? { budgetId } : skipToken);
  const appWindow = useGetConnectionSettingsQuery().data?.syncWindowDays;
  const [updateWindow, windowState] = useUpdateConnectionSyncWindowMutation();

  const [tab, setTab] = useState<string>(OVERVIEW);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const back = useCallback(() => router.replace(LIST_HREF), [router]);
  const removed = useCallback(() => router.replace(REMOVED_HREF), [router]);
  const syncStatus = useSyncStatus();
  const actions = useConnectionActions({ budgetId, onRemoved: removed });
  const { error, setError, report } = actions;

  const pickWindow = useCallback(
    async (days: number | null) => {
      if (!id) return;
      setError(null);
      try {
        await updateWindow({ id, syncWindowDays: days }).unwrap();
      } catch (err) {
        setError(apiErrorMessage(err, t('page.windowFailed')));
      }
    },
    [id, setError, updateWindow],
  );

  const pad = !shell.isDesktop ? { paddingTop: shell.contentTopPad } : null;

  if (connectionsQuery.isLoading) {
    return (
      <View style={[styles.screen, pad]}>
        <View style={styles.center}>
          <ActivityIndicator color={colors.indigo2} />
        </View>
      </View>
    );
  }

  // Unknown id, or the bank was removed (disconnected rows have no page).
  if (!connection || !live) {
    return (
      <View style={[styles.screen, pad]}>
        <View style={[styles.body, styles.gap]}>
          <View style={styles.head}>
            <Text style={styles.title}>{t('page.title')}</Text>
            <GhostButton label={tCommon('close')} onPress={back} />
          </View>
          <Text style={styles.hint}>{t('page.unlinked')}</Text>
        </View>
      </View>
    );
  }

  const name = bankDisplayName(connection.institution, connection.provider);
  const syncEntry = syncStatus.entry(connection.id);
  const view = syncEntry ? syncStateView(syncEntry.state) : connectionStatusView(connection.status);
  const connected = canRequestSync(connection.status);
  const syncing = actions.syncingId === connection.id || syncEntry?.state === 'syncing';
  const summary = summaryQuery.data;
  const linkedCount = summary?.accounts.length ?? 0;
  const activeAccount = tab === OVERVIEW ? null : (summary?.accounts.find((a) => a.accountId === tab) ?? null);
  const wide = !shell.isPhone;
  const sandbox = connection.environment === 'sandbox';
  const lastSyncLine = connection.last_synced_at
    ? t(sandbox ? 'page.lastSyncSandbox' : 'page.lastSync', { stamp: formatSyncStamp(connection.last_synced_at) })
    : t(sandbox ? 'page.addedSandbox' : 'page.added', { stamp: formatSyncStamp(connection.created_at) });

  const settings = (
    <SettingsPanel
      connection={connection}
      appWindow={appWindow}
      windowSaving={windowState.isLoading}
      busy={actions.busy}
      reimporting={actions.reimportingId === connection.id}
      linkedCount={linkedCount}
      onPickWindow={(days) => void pickWindow(days)}
      onReimport={() => void actions.reimport(connection)}
      onReconnect={() =>
        router.push(`/connect-bank?itemId=${connection.external_id}&connectionId=${connection.id}` as Href)
      }
      onRemove={() => actions.requestRemove(connection, linkedCount)}
    />
  );

  const tabLabel = (accountId: string, fallback: string, externalId: string | null) =>
    up?.accounts?.find((a) => a.externalId === externalId)?.name ?? fallback;

  return (
    <View style={[styles.screen, pad]}>
      <View style={styles.frame}>
        <View style={[styles.body, styles.gap]}>
          <View style={styles.head}>
            <Pressable onPress={back} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('page.backLabel')}>
              <Text style={styles.backText}>{t('page.backText')}</Text>
            </Pressable>
          </View>
          <View style={[styles.identity, shell.isPhone && styles.identityPhone]}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
            </View>
            <View style={styles.identityMeta}>
              <View style={styles.nameLine}>
                <Text style={[styles.title, shell.isPhone && styles.titlePhone]} numberOfLines={1}>
                  {name}
                </Text>
                <View style={[styles.statusPill, { backgroundColor: STATUS_BG[view.tone] }]}>
                  <Text style={[styles.statusText, { color: STATUS_FG[view.tone] }]}>{view.label}</Text>
                </View>
              </View>
              <Text style={styles.sub}>
                {lastSyncLine}
              </Text>
            </View>
            <View style={styles.actions}>
              <IndigoButton
                label={syncing ? t('page.syncing') : t('page.syncNow')}
                disabled={!connected || actions.busy}
                onPress={() => void actions.sync(connection)}
                style={styles.btn}
              />
              <GhostButton label={t('page.settings')} onPress={() => setSettingsOpen((v) => !v)} style={styles.btn} />
            </View>
          </View>

          {syncStatus.banner ? (
            <View style={styles.reportBanner}>
              <Text style={styles.reportText}>{syncStatus.banner}</Text>
            </View>
          ) : null}
          {connection.status === 'paused' ? (
            <PausedNotice row={connection} onOpenKeys={() => router.push(PLUGGY_KEYS_ROUTE as Href)} />
          ) : connection.status_message && connection.status !== 'connected' ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>{storedServerMessage(connection.status_message, connection.status_message_code)}</Text>
            </View>
          ) : null}
          {error ? (
            <View style={styles.banner}>
              <Text style={styles.bannerText}>{humanizeConnectionError(error)}</Text>
            </View>
          ) : null}
          {report ? (
            <View style={styles.reportBanner}>
              <Text style={styles.reportText}>{report}</Text>
            </View>
          ) : null}

          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.tabsScroll} contentContainerStyle={styles.tabs}>
            <Chip label={t('page.overview')} active={tab === OVERVIEW} onPress={() => setTab(OVERVIEW)} />
            {(summary?.accounts ?? []).map((a) => (
              <Chip
                key={a.accountId}
                label={tabLabel(a.accountId, a.name, a.externalAccountId)}
                active={tab === a.accountId}
                onPress={() => setTab(a.accountId)}
              />
            ))}
          </ScrollView>

          <View style={styles.main}>
            {summaryQuery.isLoading || !summary ? (
              <View style={styles.center}>
                {summaryQuery.isError ? <Text style={styles.hint}>{t('page.loadFailed')}</Text> : <ActivityIndicator color={colors.indigo2} />}
              </View>
            ) : tab === OVERVIEW || !activeAccount ? (
              <ScrollView contentContainerStyle={styles.overviewContent}>
                {upstreamQuery.isError ? (
                  <View style={styles.banner}>
                    <Text style={styles.bannerText}>{t('page.upstreamFailed')}</Text>
                    <GhostButton label={tCommon('retry')} onPress={() => void upstreamQuery.refetch()} />
                  </View>
                ) : null}
                <OverviewTab
                  budgetId={budgetId ?? ''}
                  connectionId={connection.id}
                  institution={connection.institution}
                  allUpstream={upstreamQuery.data ?? []}
                  summary={summary}
                  upstream={up?.accounts ?? null}
                  accounts={accountsQuery.data ?? []}
                  transactions={transactionsQuery.data ?? []}
                  onOpenAccount={setTab}
                />
              </ScrollView>
            ) : (
              <AccountTab key={activeAccount.accountId} connectionId={connection.id} accountId={activeAccount.accountId} wide={wide} />
            )}
          </View>
        </View>

        {shell.isDesktop && settingsOpen ? (
          <View style={styles.panel}>
            <View style={styles.panelHead}>
              <Text style={styles.panelTitle}>{t('page.settings')}</Text>
              <GhostButton label={tCommon('close')} onPress={() => setSettingsOpen(false)} />
            </View>
            <ScrollView>{settings}</ScrollView>
          </View>
        ) : null}
      </View>

      {!shell.isDesktop ? (
        <OverlaySheet visible={settingsOpen} onClose={() => setSettingsOpen(false)} title={t('page.settingsTitle', { name })}>
          <ScrollView style={styles.sheetScroll}>{settings}</ScrollView>
        </OverlaySheet>
      ) : null}
    </View>
  );
}

function Chip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} style={[styles.chip, active && styles.chipActive]} accessibilityRole="tab" accessibilityState={{ selected: active }}>
      <Text style={[styles.chipText, active && styles.chipTextActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  // Capped content width: the page never stretches edge to edge.
  frame: { flex: 1, width: '100%', maxWidth: 1100, alignSelf: 'center', flexDirection: 'row', padding: 16, gap: 16 },
  body: { flex: 1, minWidth: 0 },
  gap: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  backText: { color: colors.indigo3, fontSize: 13, fontWeight: '600' },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', flexShrink: 1 },
  titlePhone: { fontSize: 18 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: 32 },
  hint: { color: colors.muted, fontSize: 13 },
  identity: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  identityPhone: { flexWrap: 'wrap' },
  identityMeta: { flex: 1, gap: 2, minWidth: 180 },
  avatar: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.indigoSoft },
  avatarText: { color: colors.indigo3, fontSize: 18, fontWeight: '700' },
  nameLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  sub: { color: colors.muted, fontSize: 12 },
  statusPill: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  statusText: { fontSize: 11, fontWeight: '600' },
  actions: { flexDirection: 'row', gap: 8 },
  btn: { minHeight: 40, justifyContent: 'center' },
  banner: { backgroundColor: colors.redPillBg, borderColor: colors.border2, borderWidth: 1, borderRadius: radius.sm, padding: 10 },
  bannerText: { color: colors.redFg, fontSize: 13 },
  reportBanner: { backgroundColor: colors.greenPillBg, borderRadius: radius.sm, padding: 10 },
  reportText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  tabsScroll: { flexGrow: 0, flexShrink: 0 },
  tabs: { gap: 8, paddingVertical: 2 },
  chip: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border2, backgroundColor: colors.card },
  chipActive: { backgroundColor: colors.indigoSoft, borderColor: colors.indigo2 },
  chipText: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  chipTextActive: { color: colors.indigo3 },
  main: { flex: 1, minHeight: 0 },
  overviewContent: { paddingBottom: 24 },
  panel: { width: 340, gap: 10, paddingLeft: 16, borderLeftWidth: 1, borderLeftColor: colors.border },
  panelHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  panelTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  sheetScroll: { maxHeight: 520 },
});
