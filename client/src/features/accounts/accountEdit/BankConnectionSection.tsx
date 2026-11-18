import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { requiresReauth , LinkedBy , LinkOptionCard } from '@/features/banks';
import { colors } from '@/ui/theme';
import { connectedToLabel, unmatchedLinkHint } from './accountEdit.logic';
import { styles } from './styles';
import type { AccountEdit } from './useAccountEdit';

const STATUS_COLOR = {
  ok: colors.green,
  warn: colors.yellow,
  bad: colors.redFg,
  off: colors.muted,
} as const;

/**
 * BANK CONNECTION body: the linked bank with its status, the upstream account
 * being followed and the sync / reconnect / relink / unlink actions; or the
 * "not linked" call to action.
 */
export function BankConnectionSection({ edit }: { edit: AccountEdit }) {
  const {
    account,
    connection,
    status,
    upstream,
    linkedOption,
    syncing,
    syncNow,
    reconnect,
    manageOnBankPage,
    connectNewBank,
    setPickerOpen,
    setUnlinkAsk,
    linkBusy,
  } = edit;
  return connection && status ? (
    <View style={styles.connBox}>
      <View style={styles.connRow}>
        <Text style={styles.connGlyph}>🏦</Text>
        <Text style={styles.connName} numberOfLines={1}>
          {connectedToLabel(account.institution, connection.institution)}
        </Text>
        <Text style={[styles.connStatus, { color: STATUS_COLOR[status.tone] }]}>{status.label}</Text>
      </View>
      <LinkedBy linkedBy={account.linked_by ?? connection.linked_by} />
      <View style={styles.linkedCard}>
        {upstream.isLoading ? (
          <ActivityIndicator size="small" color={colors.indigo2} />
        ) : linkedOption ? (
          <>
            <Text style={styles.followLabel}>FOLLOWING</Text>
            <LinkOptionCard option={linkedOption} />
          </>
        ) : (
          <Text style={styles.hint}>
            {unmatchedLinkHint(upstream.data)}
          </Text>
        )}
      </View>
      <View style={styles.connActions}>
        <Pressable style={styles.connBtn} disabled={syncing} onPress={() => void syncNow()}>
          <Text style={styles.ghostText}>{syncing ? 'Syncing…' : 'Sync now'}</Text>
        </Pressable>
        {requiresReauth(connection.status) ? (
          <Pressable style={styles.warnBtn} onPress={reconnect}>
            <Text style={styles.warnText}>Reconnect</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.connBtn} accessibilityRole="button" onPress={manageOnBankPage}>
          <Text style={styles.ghostText}>Manage on bank page</Text>
        </Pressable>
        <Pressable style={styles.connBtn} onPress={() => setPickerOpen(true)}>
          <Text style={styles.ghostText}>Change link</Text>
        </Pressable>
        <Pressable style={styles.connBtn} disabled={linkBusy} onPress={() => setUnlinkAsk(true)}>
          <Text style={styles.unlinkText}>Unlink</Text>
        </Pressable>
      </View>
    </View>
  ) : (
    <View style={styles.linkBox}>
      <Text style={styles.hint}>
        Not linked to a bank. Connect one to import transactions and update the balance automatically.
      </Text>
      <Pressable
        style={styles.chooseBtn}
        accessibilityRole="button"
        accessibilityLabel="Choose bank account"
        onPress={() => setPickerOpen(true)}>
        <Text style={styles.chooseBtnText}>Choose bank account</Text>
      </Pressable>
      <Pressable
        style={styles.linkBtn}
        accessibilityRole="button"
        accessibilityLabel="Connect a new bank"
        onPress={connectNewBank}>
        <Text style={styles.linkBtnText}>Connect a new bank</Text>
      </Pressable>
    </View>
  );
}
