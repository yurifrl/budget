/**
 * The key set card of "Your Pluggy keys": the entry form (empty / replacing)
 * or the saved state (client id, secret shown only as saved, Replace and
 * Remove with an inline confirmation). The secret is never shown back.
 */

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { PasswordField } from '@/features/auth';
import { colors, radius } from '@/ui/theme';
import { formatSyncStamp } from '../model/connections';
import { t } from './i18n';
import type { PluggyKeysState } from './usePluggyKeys';

export function PluggyKeysCard({ keys }: { keys: PluggyKeysState }) {
  if (keys.mode === 'loading') {
    return (
      <View style={[styles.card, styles.center]}>
        <ActivityIndicator color={colors.indigo2} />
      </View>
    );
  }
  if (keys.mode === 'failed') {
    return (
      <View style={styles.card}>
        <Text style={styles.errorText}>{t('card.loadFailed')}</Text>
        <Button label={tCommon('retry')} onPress={() => void keys.retry()} />
      </View>
    );
  }
  return keys.mode === 'saved' ? <SavedKeys keys={keys} /> : <KeysForm keys={keys} />;
}

function SavedKeys({ keys }: { keys: PluggyKeysState }) {
  const { credentials } = keys;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t('card.yourKeys')}</Text>
      <Row label={t('card.clientId')} value={credentials?.clientId ?? ''} />
      <Row label={t('card.clientSecret')} value={t('card.secretSaved')} />
      {credentials?.updatedAt ? <Text style={styles.muted}>{t('card.savedAt', { stamp: formatSyncStamp(credentials.updatedAt) })}</Text> : null}
      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}
      {keys.error?.field === 'form' ? <Text style={styles.errorText}>{keys.error.message}</Text> : null}
      {keys.confirmingRemove ? (
        <View style={styles.confirm}>
          <Text style={styles.body}>{t('card.removeConfirm')}</Text>
          <View style={styles.row}>
            <Button label={tCommon('cancel')} onPress={() => keys.setConfirmingRemove(false)} grow />
            <Button label={keys.removing ? t('card.removing') : t('card.removeKeys')} danger busy={keys.removing} onPress={() => void keys.remove()} grow />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <Button label={t('card.replaceKeys')} onPress={keys.startReplace} grow />
          <Button label={tCommon('remove')} danger onPress={() => keys.setConfirmingRemove(true)} grow />
        </View>
      )}
    </View>
  );
}

function KeysForm({ keys }: { keys: PluggyKeysState }) {
  const { error } = keys;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{keys.mode === 'replacing' ? t('card.replaceTitle') : t('card.addTitle')}</Text>
      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}
      <PasswordField
        label={t('card.clientId')}
        value={keys.clientId}
        onChangeText={keys.setClientId}
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        spellCheck={false}
        placeholder={t('card.clientIdPlaceholder')}
        invalid={error?.field === 'clientId'}
      />
      {error?.field === 'clientId' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <PasswordField
        label={t('card.clientSecret')}
        value={keys.clientSecret}
        onChangeText={keys.setClientSecret}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        spellCheck={false}
        placeholder={keys.mode === 'replacing' ? t('card.secretPlaceholderNew') : t('card.secretPlaceholder')}
        returnKeyType="go"
        onSubmitEditing={() => void keys.save()}
        invalid={error?.field === 'clientSecret'}
      />
      {error?.field === 'clientSecret' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <Text style={styles.muted}>{t('card.secretHint')}</Text>
      {error?.field === 'form' ? <Text style={styles.errorText}>{error.message}</Text> : null}
      <View style={styles.row}>
        {keys.mode === 'replacing' ? <Button label={tCommon('cancel')} onPress={keys.cancelReplace} grow /> : null}
        <Button label={keys.saving ? t('card.checking') : t('card.saveKeys')} primary busy={keys.saving} onPress={() => void keys.save()} grow />
      </View>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue} selectable numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

function Button({
  label,
  onPress,
  primary,
  danger,
  busy,
  grow,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
  grow?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger, grow && styles.grow, busy && styles.btnBusy]}>
      <Text style={[styles.btnText, danger && !primary && styles.btnDangerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.card,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.card10,
    padding: 16,
    gap: 10,
  },
  center: { alignItems: 'center', paddingVertical: 32 },
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  okText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  errorText: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  kvLabel: { color: colors.muted, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  confirm: { gap: 10, backgroundColor: colors.redPillBg, borderRadius: radius.sm, padding: 12 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  grow: { flex: 1 },
  btn: {
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
  },
  btnPrimary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  btnDanger: { borderColor: colors.red },
  btnBusy: { opacity: 0.6 },
  btnText: { color: colors.text, fontSize: 14, fontWeight: '700' },
  btnDangerText: { color: colors.redFg },
});
