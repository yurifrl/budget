import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { requiresReauth , LinkedBy , LinkOptionCard } from '@/features/banks';
import { colors } from '@/ui/theme';
import { connectedToLabel, unmatchedLinkHint } from './accountEdit.logic';
import { t } from './i18n';
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
            <Text style={styles.followLabel}>{t('connection.following')}</Text>
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
          <Text style={styles.ghostText}>{syncing ? t('connection.syncing') : t('connection.syncNow')}</Text>
        </Pressable>
        {requiresReauth(connection.status) ? (
          <Pressable style={styles.warnBtn} onPress={reconnect}>
            <Text style={styles.warnText}>{t('connection.reconnect')}</Text>
          </Pressable>
        ) : null}
        <Pressable style={styles.connBtn} accessibilityRole="button" onPress={manageOnBankPage}>
          <Text style={styles.ghostText}>{t('connection.manage')}</Text>
        </Pressable>
        <Pressable style={styles.connBtn} onPress={() => setPickerOpen(true)}>
          <Text style={styles.ghostText}>{t('connection.changeLink')}</Text>
        </Pressable>
        <Pressable style={styles.connBtn} disabled={linkBusy} onPress={() => setUnlinkAsk(true)}>
          <Text style={styles.unlinkText}>{t('connection.unlink')}</Text>
        </Pressable>
      </View>
    </View>
  ) : (
    <View style={styles.linkBox}>
      <Text style={styles.hint}>
        {t('connection.notLinked')}
      </Text>
      <Pressable
        style={styles.chooseBtn}
        accessibilityRole="button"
        accessibilityLabel={t('connection.chooseAccount')}
        onPress={() => setPickerOpen(true)}>
        <Text style={styles.chooseBtnText}>{t('connection.chooseAccount')}</Text>
      </Pressable>
      <Pressable
        style={styles.linkBtn}
        accessibilityRole="button"
        accessibilityLabel={t('connection.connectNew')}
        onPress={connectNewBank}>
        <Text style={styles.linkBtnText}>{t('connection.connectNew')}</Text>
      </Pressable>
    </View>
  );
}
