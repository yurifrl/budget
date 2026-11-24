/**
 * The key set card of "Your Pluggy keys": the entry form (empty / replacing)
 * or the saved state (client id, secret shown only as saved, Replace and
 * Remove with an inline confirmation). The secret is never shown back. Card,
 * rows, buttons, the confirm and the loading/failed states are the shared
 * credential-card pieces from `@/ui/bits`.
 */

import { Text } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import {
  SettingsCard,
  SettingsCardActions,
  SettingsCardButton,
  SettingsCardFailed,
  SettingsCardLoading,
  SettingsCardRow,
  SettingsCardSection,
  SettingsConfirm,
  settingsCardText,
} from '@/ui/bits';
import { PasswordField } from '@/ui/PasswordField';
import { formatSyncStamp } from '../model/connections';
import { t } from './i18n';
import type { PluggyKeysState } from './usePluggyKeys';

export function PluggyKeysCard({ keys }: { keys: PluggyKeysState }) {
  if (keys.mode === 'loading') return <SettingsCardLoading />;
  if (keys.mode === 'failed') {
    return <SettingsCardFailed message={t('card.loadFailed')} retryLabel={tCommon('retry')} onRetry={() => void keys.retry()} />;
  }
  return keys.mode === 'saved' ? <SavedKeys keys={keys} /> : <KeysForm keys={keys} />;
}

function SavedKeys({ keys }: { keys: PluggyKeysState }) {
  const { credentials } = keys;
  return (
    <SettingsCard>
      <SettingsCardSection label={t('card.yourKeys')} />
      <SettingsCardRow label={t('card.clientId')} value={credentials?.clientId ?? ''} />
      <SettingsCardRow label={t('card.clientSecret')} value={t('card.secretSaved')} />
      {credentials?.updatedAt ? (
        <Text style={settingsCardText.muted}>{t('card.savedAt', { stamp: formatSyncStamp(credentials.updatedAt) })}</Text>
      ) : null}
      {keys.notice ? <Text style={settingsCardText.ok}>{keys.notice}</Text> : null}
      {keys.error?.field === 'form' ? <Text style={settingsCardText.error}>{keys.error.message}</Text> : null}
      {keys.confirmingRemove ? (
        <SettingsConfirm
          message={t('card.removeConfirm')}
          cancelLabel={tCommon('cancel')}
          confirmLabel={keys.removing ? t('card.removing') : t('card.removeKeys')}
          busy={keys.removing}
          onCancel={() => keys.setConfirmingRemove(false)}
          onConfirm={() => void keys.remove()}
        />
      ) : (
        <SettingsCardActions>
          <SettingsCardButton label={t('card.replaceKeys')} onPress={keys.startReplace} grow />
          <SettingsCardButton label={tCommon('remove')} danger onPress={() => keys.setConfirmingRemove(true)} grow />
        </SettingsCardActions>
      )}
    </SettingsCard>
  );
}

function KeysForm({ keys }: { keys: PluggyKeysState }) {
  const { error } = keys;
  return (
    <SettingsCard>
      <SettingsCardSection label={keys.mode === 'replacing' ? t('card.replaceTitle') : t('card.addTitle')} />
      {keys.notice ? <Text style={settingsCardText.ok}>{keys.notice}</Text> : null}
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
      {error?.field === 'clientId' ? <Text style={settingsCardText.error}>{error.message}</Text> : null}
      <PasswordField
        label={t('card.clientSecret')}
        value={keys.clientSecret}
        onChangeText={keys.setClientSecret}
        secureTextEntry
        credential
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="none"
        spellCheck={false}
        placeholder={keys.mode === 'replacing' ? t('card.secretPlaceholderNew') : t('card.secretPlaceholder')}
        returnKeyType="go"
        onSubmitEditing={() => void keys.save()}
        invalid={error?.field === 'clientSecret'}
      />
      {error?.field === 'clientSecret' ? <Text style={settingsCardText.error}>{error.message}</Text> : null}
      <Text style={settingsCardText.muted}>{t('card.secretHint')}</Text>
      {error?.field === 'form' ? <Text style={settingsCardText.error}>{error.message}</Text> : null}
      <SettingsCardActions>
        {keys.mode === 'replacing' ? (
          <SettingsCardButton label={tCommon('cancel')} onPress={keys.cancelReplace} grow />
        ) : null}
        <SettingsCardButton label={keys.saving ? t('card.checking') : t('card.saveKeys')} primary busy={keys.saving} onPress={() => void keys.save()} grow />
      </SettingsCardActions>
    </SettingsCard>
  );
}
