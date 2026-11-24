/**
 * The status cards of the AI key screen: the own credential as the server
 * reports it (provider and chosen model; never the key), the blocked row it
 * cannot use, and the installation's shared AI when it is available. Card,
 * rows, buttons and the inline confirm are the shared credential-card pieces.
 */

import { StyleSheet, Text } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import type { AiCredentialStatus } from '@/budget/data/api';
import {
  SettingsCard,
  SettingsCardActions,
  SettingsCardButton,
  SettingsCardRow,
  SettingsCardSection,
  SettingsConfirm,
  settingsCardText,
} from '@/ui/bits';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { localDatePart, providerLabel } from './aiKeys.logic';
import { t } from './i18n';
import type { AiKeysState } from './useAiKeys';

export function AiKeySavedCard({ keys }: { keys: AiKeysState }) {
  const own = keys.status?.own;
  const fmt = useMoneyFormat();
  if (!own) return null;
  return (
    <SettingsCard>
      <SettingsCardSection label={t('state.ownTitle')} />
      {keys.unreadable ? (
        <Text style={styles.warn} accessibilityLiveRegion="polite">
          {t('state.unreadable')}
        </Text>
      ) : null}
      <SettingsCardRow label={t('state.provider')} value={providerLabel(own.provider)} />
      <SettingsCardRow label={t('state.model')} value={own.model ?? t('state.none')} lines={2} />
      {own.model === null ? <Text style={settingsCardText.body}>{t('state.noModel')}</Text> : null}
      <Text style={settingsCardText.muted}>{t('state.savedAt', { date: fmt.formatDate(localDatePart(own.updated_at)) })}</Text>

      {keys.notice ? (
        <Text style={settingsCardText.ok} accessibilityLiveRegion="polite">
          {keys.notice}
        </Text>
      ) : null}
      {keys.testResult ? (
        <Text style={settingsCardText.ok} accessibilityLiveRegion="polite">
          {t('state.testOk', { count: keys.testResult.models, provider: providerLabel(keys.testResult.provider) })}
        </Text>
      ) : null}
      {keys.testError ? (
        <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
          {keys.testError}
        </Text>
      ) : null}
      {keys.error?.field === 'form' ? (
        <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
          {keys.error.message}
        </Text>
      ) : null}

      {keys.confirmingRemove ? (
        <SettingsConfirm
          message={t('state.removeConfirm')}
          cancelLabel={tCommon('cancel')}
          confirmLabel={keys.removing ? t('state.removing') : t('state.remove')}
          busy={keys.removing}
          onCancel={() => keys.setConfirmingRemove(false)}
          onConfirm={() => void keys.remove()}
        />
      ) : keys.unreadable ? (
        // Test can only fail with ai_key_unreadable, and the fix is a new key.
        <SettingsCardActions wrap>
          <SettingsCardButton label={t('state.saveNewKey')} primary onPress={keys.startReplace} />
          <SettingsCardButton label={t('state.remove')} danger onPress={() => keys.setConfirmingRemove(true)} />
        </SettingsCardActions>
      ) : (
        <SettingsCardActions wrap>
          <SettingsCardButton
            label={keys.testing ? t('state.testing') : t('state.test')}
            busy={keys.testing}
            onPress={() => void keys.test()}
          />
          <SettingsCardButton label={t('state.replace')} onPress={keys.startReplace} />
          <SettingsCardButton label={t('state.remove')} danger onPress={() => keys.setConfirmingRemove(true)} />
        </SettingsCardActions>
      )}
    </SettingsCard>
  );
}

/**
 * A stored row this server cannot use (unknown provider / unreadable secret).
 * The shared fallback is blocked by it, so this must not read as "shared AI in
 * use": offer saving a new key or removing the row (Remove works without it).
 */
export function BlockedAiCard({ keys }: { keys: AiKeysState }) {
  return (
    <SettingsCard>
      <SettingsCardSection label={t('state.blockedTitle')} />
      <Text style={styles.warn} accessibilityLiveRegion="polite">
        {t('state.blocked')}
      </Text>
      {keys.error?.field === 'form' ? (
        <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
          {keys.error.message}
        </Text>
      ) : null}
      {keys.confirmingRemove ? (
        <SettingsConfirm
          message={t('state.removeConfirm')}
          cancelLabel={tCommon('cancel')}
          confirmLabel={keys.removing ? t('state.removing') : t('state.remove')}
          busy={keys.removing}
          onCancel={() => keys.setConfirmingRemove(false)}
          onConfirm={() => void keys.remove()}
        />
      ) : (
        <SettingsCardActions wrap>
          <SettingsCardButton label={t('state.saveNewKey')} primary onPress={keys.startReplace} />
          <SettingsCardButton label={t('state.remove')} danger onPress={() => keys.setConfirmingRemove(true)} />
        </SettingsCardActions>
      )}
    </SettingsCard>
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
    <SettingsCard>
      <SettingsCardSection label={t('shared.title')} />
      <Text style={settingsCardText.body}>{body}</Text>
    </SettingsCard>
  );
}

const styles = StyleSheet.create({
  warn: { color: colors.yellowPillFg, fontSize: 13, lineHeight: 18, fontWeight: '600' },
});
