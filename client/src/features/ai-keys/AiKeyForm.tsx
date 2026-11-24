/**
 * The entry form of the AI key screen: paste the key, see the detected
 * provider (Z.ai is never detected, so an unknown shape asks the user to
 * choose instead of failing), switch the provider by hand, then pick one of
 * that provider's models and save. Detection and the model list are
 * best-effort reads of the candidate key; only Save sends it for keeps.
 *
 * When the list cannot be fetched for a retryable reason (rate limit, upstream
 * failure, network) the form explains it, takes a typed model id and still
 * lets the key be saved without one. A rejected key gets only the message.
 * Z.ai's list is a suggestion, so a typed id is the model on Save even when
 * the list loaded.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import {
  SettingsCard,
  SettingsCardActions,
  SettingsCardButton,
  SettingsCardSection,
  settingsCardText,
} from '@/ui/bits';
import { Combobox } from '@/ui/combobox';
import { PasswordField } from '@/ui/PasswordField';
import { colors, radius } from '@/ui/theme';
import { MIN_AI_KEY_LENGTH, modelOptions, providerOptions } from './aiKeys.logic';
import { t } from './i18n';
import type { AiKeysState } from './useAiKeys';

export function AiKeyForm({ keys }: { keys: AiKeysState }) {
  // A blocked row also opens this form; Cancel must return to its card.
  const replacing = keys.mode === 'saved' || keys.mode === 'blocked';
  const showManualModel = keys.modelsError !== null && keys.modelsRetryable;
  return (
    <SettingsCard>
      <SettingsCardSection label={replacing ? t('form.replaceTitle') : t('form.addTitle')} />
      {keys.notice ? (
        <Text style={settingsCardText.ok} accessibilityLiveRegion="polite">
          {keys.notice}
        </Text>
      ) : null}

      <PasswordField
        label={t('form.keyLabel')}
        value={keys.apiKey}
        onChangeText={keys.setApiKey}
        secureTextEntry
        credential
        autoCapitalize="none"
        autoCorrect={false}
        textContentType="none"
        spellCheck={false}
        placeholder={t('form.keyPlaceholder')}
        accessibilityHint={keys.providerHint ?? undefined}
        invalid={keys.error?.field === 'key'}
      />
      {keys.error?.field === 'key' ? (
        <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
          {keys.error.message}
        </Text>
      ) : null}
      <Text style={settingsCardText.muted}>{t('form.keyHint')}</Text>
      {keys.providerHint ? (
        <Text style={styles.hint} accessibilityLiveRegion="polite">
          {keys.providerHint}
        </Text>
      ) : null}

      <Text style={styles.label}>{t('form.providerLabel')}</Text>
      <View style={styles.chips} accessibilityRole="radiogroup">
        {providerOptions().map((option) => {
          const selected = option.id === keys.provider;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="radio"
              accessibilityState={{ checked: selected }}
              onPress={() => keys.chooseProvider(option.id)}
              style={[styles.chip, selected && styles.chipSelected]}>
              <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{option.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {keys.modelsReady ? (
        <View style={styles.models}>
          <Text style={styles.label}>{t('form.modelLabel')}</Text>
          {keys.modelsPending ? (
            <Text style={settingsCardText.muted}>{t('form.modelsLoading')}</Text>
          ) : null}
          {!keys.modelsLoading && keys.modelsError ? (
            <>
              <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
                {keys.modelsError}
              </Text>
              {showManualModel ? (
                <>
                  <TextInput
                    value={keys.modelQuery}
                    onChangeText={keys.editModelQuery}
                    placeholder={t('form.modelPlaceholder')}
                    placeholderTextColor={colors.faint}
                    autoCapitalize="none"
                    autoCorrect={false}
                    spellCheck={false}
                    accessibilityLabel={t('form.modelLabel')}
                    style={styles.input}
                  />
                  <Text style={settingsCardText.muted}>{t('form.manualModelHint')}</Text>
                  <View style={styles.retry}>
                    <SettingsCardButton label={tCommon('retry')} onPress={keys.retryModels} />
                  </View>
                </>
              ) : null}
            </>
          ) : null}
          {keys.modelsLoaded && !keys.modelsError ? (
            <>
              {keys.provider === 'zai' ? <Text style={settingsCardText.muted}>{t('form.zaiTypedHint')}</Text> : null}
              <Combobox
                value={keys.modelQuery}
                onChangeText={keys.editModelQuery}
                options={modelOptions(keys.models)}
                onPick={keys.chooseModel}
                onCreate={keys.provider === 'zai' ? keys.editModelQuery : undefined}
                createLabel={(query) => t('form.useTypedModel', { model: query })}
                placeholder={t('form.modelPlaceholder')}
                chevron
                accessibilityLabel={t('form.modelLabel')}
              />
            </>
          ) : null}
          {keys.modelsLoaded && keys.models.length === 0 ? (
            <Text style={settingsCardText.muted}>{t('form.modelsEmpty')}</Text>
          ) : null}
        </View>
      ) : null}

      {keys.effectiveModel === null &&
      keys.apiKey.trim().length >= MIN_AI_KEY_LENGTH &&
      !keys.modelsLoading &&
      (keys.modelsLoaded || keys.modelsRetryable) ? (
        <Text style={settingsCardText.muted}>{t('form.saveWithoutModel')}</Text>
      ) : null}

      {keys.error?.field === 'form' ? (
        <Text style={settingsCardText.error} accessibilityLiveRegion="polite">
          {keys.error.message}
        </Text>
      ) : null}

      <SettingsCardActions>
        {replacing ? <SettingsCardButton label={tCommon('cancel')} onPress={keys.cancelReplace} /> : null}
        <SettingsCardButton
          label={keys.saving ? t('form.saving') : t('form.save')}
          primary
          busy={keys.saving}
          disabled={!keys.canSave}
          onPress={() => void keys.save()}
        />
      </SettingsCardActions>
    </SettingsCard>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  hint: { color: colors.indigo3, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 44,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    paddingHorizontal: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipSelected: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  chipText: { color: colors.text, fontSize: 13, fontWeight: '700' },
  chipTextSelected: { color: colors.white },
  models: { gap: 8 },
  input: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.card10,
    color: colors.text,
    fontSize: 16,
    minHeight: 48,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  retry: { alignSelf: 'flex-start' },
});
