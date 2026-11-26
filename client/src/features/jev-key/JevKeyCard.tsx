/**
 * The card of "Jev API key": the field (no key saved yet, or after Replace) or
 * the saved state (masked ending, the date, Test / Replace / Remove with an
 * inline confirmation). The key is never shown back. Card, rows, buttons, the
 * confirm and the loading/failed states are the shared credential-card pieces
 * from `@/ui/bits`.
 */

import { Text } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { PasswordField } from '@/ui/PasswordField';
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
import { useMoneyFormat } from '@/ui/moneyFormat';

import { t } from './i18n';
import { savedOn, serverKeyInUse } from './jevKey.logic';
import type { JevKeyState } from './useJevKey';

export function JevKeyCard({ keys }: { keys: JevKeyState }) {
  if (keys.mode === 'loading') return <SettingsCardLoading />;
  if (keys.mode === 'failed') {
    return <SettingsCardFailed message={keys.loadError} retryLabel={tCommon('retry')} onRetry={keys.retry} />;
  }
  return keys.mode === 'saved' ? <SavedKey keys={keys} /> : <KeyForm keys={keys} />;
}

function SavedKey({ keys }: { keys: JevKeyState }) {
  const fmt = useMoneyFormat();
  const status = keys.status;
  const date = status ? savedOn(status) : null;
  return (
    <SettingsCard>
      <SettingsCardSection label={t('card.savedSection')} />
      <SettingsCardRow label={t('card.field')} value={t('card.ending', { last4: status?.last_four ?? '' })} />
      {date ? <Text style={settingsCardText.muted}>{t('card.savedAt', { date: fmt.formatDateLong(date) })}</Text> : null}
      {keys.unreadable ? <Text style={settingsCardText.error}>{keys.unreadable}</Text> : null}
      {keys.notice ? <Text style={settingsCardText.ok}>{keys.notice}</Text> : null}
      {keys.error ? <Text style={settingsCardText.error}>{keys.error}</Text> : null}
      {keys.confirmingRemove ? (
        <SettingsConfirm
          message={t('card.removeConfirm')}
          cancelLabel={tCommon('cancel')}
          confirmLabel={tCommon('remove')}
          busy={keys.removing}
          onCancel={() => keys.setConfirmingRemove(false)}
          onConfirm={() => void keys.remove()}
        />
      ) : (
        <SettingsCardActions>
          <SettingsCardButton
            label={keys.testing ? t('card.testing') : t('card.test')}
            busy={keys.testing}
            onPress={() => void keys.test()}
            grow
          />
          <SettingsCardButton label={t('card.replace')} onPress={keys.startReplace} grow />
          <SettingsCardButton label={tCommon('remove')} danger onPress={() => keys.setConfirmingRemove(true)} grow />
        </SettingsCardActions>
      )}
    </SettingsCard>
  );
}

function KeyForm({ keys }: { keys: JevKeyState }) {
  return (
    <SettingsCard>
      {serverKeyInUse(keys.status) ? (
        <>
          <SettingsCardSection label={t('card.serverKey')} />
          <Text style={settingsCardText.muted}>{t('card.serverKeyBody')}</Text>
        </>
      ) : null}
      {keys.notice ? <Text style={settingsCardText.ok}>{keys.notice}</Text> : null}
      <PasswordField
        label={t('card.field')}
        value={keys.field}
        onChangeText={keys.setField}
        secureTextEntry
        credential
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="none"
        spellCheck={false}
        returnKeyType="go"
        onSubmitEditing={() => void keys.save()}
        invalid={keys.error !== null}
      />
      {keys.error ? <Text style={settingsCardText.error}>{keys.error}</Text> : null}
      <SettingsCardActions>
        {keys.replacing ? <SettingsCardButton label={tCommon('cancel')} onPress={keys.cancelReplace} grow /> : null}
        <SettingsCardButton
          label={keys.saving ? t('card.checking') : t('card.save')}
          primary
          busy={keys.saving}
          onPress={() => void keys.save()}
          grow
        />
      </SettingsCardActions>
    </SettingsCard>
  );
}
