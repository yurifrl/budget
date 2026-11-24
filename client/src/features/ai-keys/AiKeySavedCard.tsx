/**
 * The saved-state card of the AI key screen: the own credential as the server
 * reports it (provider and chosen model; never the key), when it was saved,
 * and Test / Replace / Remove (Remove confirms inline). Second card: the
 * installation's shared AI, shown when no own key is saved and the feature
 * makes it available to this account.
 */

import { StyleSheet, Text, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import type { AiCredentialStatus } from '@/budget/data/api';
import { colors, radius } from '@/ui/theme';
import { providerLabel } from './aiKeys.logic';
import { AiKeyButton } from './AiKeyButton';
import { t } from './i18n';
import type { AiKeysState } from './useAiKeys';

export function AiKeySavedCard({ keys }: { keys: AiKeysState }) {
  const own = keys.status?.own;
  if (!own) return null;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t('state.ownTitle')}</Text>
      <Row label={t('state.provider')} value={providerLabel(own.provider)} />
      <Row label={t('state.model')} value={own.model ?? t('state.noModel')} />
      <Text style={styles.muted}>{t('state.savedAt', { date: own.updated_at.slice(0, 10) })}</Text>

      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}
      {keys.testResult ? (
        <Text style={styles.okText}>
          {t('state.testOk', { count: keys.testResult.models, provider: providerLabel(keys.testResult.provider) })}
        </Text>
      ) : null}
      {keys.testError ? <Text style={styles.errorText}>{keys.testError}</Text> : null}
      {keys.error?.field === 'form' ? <Text style={styles.errorText}>{keys.error.message}</Text> : null}

      {keys.confirmingRemove ? (
        <View style={styles.confirm}>
          <Text style={styles.body}>{t('state.removeConfirm')}</Text>
          <View style={styles.row}>
            <AiKeyButton label={tCommon('cancel')} onPress={() => keys.setConfirmingRemove(false)} />
            <AiKeyButton
              label={keys.removing ? t('state.removing') : t('state.remove')}
              danger
              busy={keys.removing}
              onPress={() => void keys.remove()}
            />
          </View>
        </View>
      ) : (
        <View style={styles.row}>
          <AiKeyButton
            label={keys.testing ? t('state.testing') : t('state.test')}
            busy={keys.testing}
            onPress={() => void keys.test()}
          />
          <AiKeyButton label={t('state.replace')} onPress={keys.startReplace} />
          <AiKeyButton label={t('state.remove')} danger onPress={() => keys.setConfirmingRemove(true)} />
        </View>
      )}
    </View>
  );
}

/** The shared key of the installation, as far as this account may use it (no own key saved). */
export function SharedAiCard({ status }: { status: AiCredentialStatus }) {
  const { shared } = status;
  const body =
    shared.provider !== null && shared.model !== null
      ? t('shared.body', { provider: providerLabel(shared.provider), model: shared.model })
      : t('shared.bodyNoModel');
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t('shared.title')}</Text>
      <Text style={styles.body}>{body}</Text>
    </View>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue} selectable numberOfLines={2}>
        {value}
      </Text>
    </View>
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
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  okText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  errorText: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  kvLabel: { color: colors.muted, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1, textAlign: 'right' },
  confirm: { gap: 10, backgroundColor: colors.redPillBg, borderRadius: radius.sm, padding: 12 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4 },
});
