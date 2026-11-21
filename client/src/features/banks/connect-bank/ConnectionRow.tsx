import { Platform, Pressable, Text, View } from 'react-native';

import type { ConnectionJson, ConnectionUpstreamJson } from '@/budget/data/connections';
import type { AccountRow, TransactionRow } from '@/budget/data/rows';
import { connectionStatusView, requiresReauth } from '../model/connections';
import { connectionSparkData } from '../model/connectionSpark';
import { canRequestSync, syncStateView } from '../model/syncRun';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { PausedNotice } from '../keys/PausedNotice';
import { LinkedBy } from '../LinkedBy';
import { Sparkline } from '@/ui/Sparkline';
import { colors } from '@/ui/theme';
import { connectionName, connectionSubline, linkedAccountCount } from './connectBank.logic';
import { ConnectionRowButtons } from './ConnectionRowButtons';
import { ConnectionRowMenu } from './ConnectionRowMenu';
import { t } from './i18n';
import { styles } from './screenStyles';
import { UpstreamAccountsList } from './UpstreamAccountsList';
import type { useSyncStatus } from './useSyncStatus';

const STATUS_BG = { ok: colors.greenPillBg, warn: colors.yellowPillBg, bad: colors.redPillBg, off: colors.grayPillBg } as const;
const STATUS_FG = { ok: colors.greenPillFg, warn: colors.yellowPillFg, bad: colors.redFg, off: colors.grayPillFg } as const;

/** One linked bank: status, last sync, activity sparkline + balance, row actions and its upstream accounts. */
export function ConnectionRow({
  row,
  syncEntry,
  accounts,
  transactions,
  up,
  busy,
  syncing,
  wide,
  onSync,
  onReimport,
  onReconnect,
  onSettings,
  onOpenKeys,
  onDisconnect,
}: {
  row: ConnectionJson;
  /** Live background-sync state of this connection, when one is known. */
  syncEntry: ReturnType<ReturnType<typeof useSyncStatus>['entry']>;
  accounts: AccountRow[];
  transactions: TransactionRow[];
  /** This connection's upstream accounts and their links — read-only here;
   *  the account editor owns the linking choice. */
  up: ConnectionUpstreamJson | undefined;
  busy: boolean;
  /** This row's Sync is running (button spinner). */
  syncing: boolean;
  /** Room for the sparkline (phone rows are tight). */
  wide: boolean;
  onSync: () => void;
  onReimport: () => void;
  onReconnect: () => void;
  /** Edit (⋯) / row press: the bank's own configuration page. */
  onSettings: () => void;
  /** A paused row's "add your keys" action: the keys screen. */
  onOpenKeys: () => void;
  onDisconnect: (linkedCount: number) => void;
}) {
  const { formatMoney } = useMoneyFormat();
  const name = connectionName(row);
  const view = syncEntry ? syncStateView(syncEntry.state) : connectionStatusView(row.status);
  const reauth = requiresReauth(row.status);
  const spark = connectionSparkData(row.id, accounts, transactions);
  const linkedCount = linkedAccountCount(up);
  return (
    // iOS: long-press opens the system context menu over the row;
    // web/Android: the wrapper is a no-op, the kebab below opens
    // the anchored popup.
    <ConnectionRowMenu
      status={row.status}
      busy={busy}
      onSync={onSync}
      onReimport={onReimport}
      onReconnect={onReconnect}
      onSettings={onSettings}
      onDisconnect={() => onDisconnect(linkedCount)}
    >
      <Pressable
        onPress={onSettings}
        // Web renders role=button as <button>, which can't nest the row's
        // own Sync/Edit buttons: keep the label, drop the role there.
        accessibilityRole={Platform.OS === 'web' ? undefined : 'button'}
        role={Platform.OS === 'web' ? 'group' : undefined}
        accessibilityLabel={t('row.openA11y', { name })}
        style={(state) => [
          styles.connCard,
          styles.connCardPress,
          ((state as { hovered?: boolean }).hovered || state.pressed) && styles.connCardHover,
        ]}
      >
      <View style={styles.connRow}>
        {/* Merged left block: avatar + name/status + last sync. */}
        <View style={[styles.avatar, { backgroundColor: colors.indigoSoft }]}>
          <Text style={styles.avatarText}>{name.charAt(0).toUpperCase()}</Text>
        </View>
        <View style={styles.connMeta}>
          <View style={styles.nameLine}>
            <Text style={styles.connName} numberOfLines={1}>
              {name}
            </Text>
            <View style={[styles.statusPill, { backgroundColor: STATUS_BG[view.tone] }]}>
              <Text style={[styles.statusText, { color: STATUS_FG[view.tone] }]}>{view.label}</Text>
            </View>
          </View>
          <Text style={styles.connSub} numberOfLines={1}>
            {connectionSubline(row, reauth)}
          </Text>
          {row.status === 'paused' ? (
            <PausedNotice row={row} compact onOpenKeys={onOpenKeys} />
          ) : row.status_message && row.status !== 'connected' ? (
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
            {wide ? (
              <Sparkline points={spark.series} width={96} height={24} fill={colors.indigo2} />
            ) : null}
            <Text style={styles.connBalance}>{formatMoney(spark.balanceCents)}</Text>
          </>
        ) : null}
        <ConnectionRowButtons
          institution={name}
          canSync={canRequestSync(row.status) && !busy}
          syncing={syncing}
          onSync={onSync}
          onEdit={onSettings}
        />
      </View>
      {up == null ? null : <UpstreamAccountsList up={up} accounts={accounts} />}
      </Pressable>
    </ConnectionRowMenu>
  );
}
