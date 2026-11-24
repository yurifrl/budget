/**
 * The entry form of the AI key screen: paste the key, see the detected
 * provider (Z.ai is never detected, so an unknown shape asks the user to
 * choose instead of failing), switch the provider by hand, then pick one of
 * that provider's models and save. Detection and the model list are
 * best-effort reads of the candidate key; only Save sends it for keeps. When
 * the provider refuses to list models (403 ai_key_forbidden) the form shows
 * why, takes a typed model id, and still lets the key be saved without one.
 */

import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { tCommon } from '@shared/i18n/common';

import { PasswordField } from '@/features/auth';
import { Combobox } from '@/ui/combobox';
import { GhostButton, IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { MIN_AI_KEY_LENGTH, modelOptions, providerOptions } from './aiKeys.logic';
import { t } from './i18n';
import type { AiKeysState } from './useAiKeys';

export function AiKeyForm({ keys }: { keys: AiKeysState }) {
  const replacing = keys.mode === 'saved';
  const canSave =
    keys.apiKey.trim().length >= MIN_AI_KEY_LENGTH &&
    keys.provider !== null &&
    !keys.saving &&
    !keys.modelsLoading;
  return (
    <View style={styles.card}>
      <Text style={styles.section}>{replacing ? t('form.replaceTitle') : t('form.addTitle')}</Text>
      {keys.notice ? <Text style={styles.okText}>{keys.notice}</Text> : null}

      <PasswordField
        label={t('form.keyLabel')}
        value={keys.apiKey}
        onChangeText={keys.setApiKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        textContentType="none"
        spellCheck={false}
        placeholder={t('form.keyPlaceholder')}
        invalid={keys.error?.field === 'key'}
      />
      {keys.error?.field === 'key' ? <Text style={styles.errorText}>{keys.error.message}</Text> : null}
      <Text style={styles.muted}>{t('form.keyHint')}</Text>
      {keys.providerHint ? <Text style={styles.hint}>{keys.providerHint}</Text> : null}

      <Text style={styles.label}>{t('form.providerLabel')}</Text>
      <View style={styles.chips}>
        {providerOptions().map((option) => {
          const selected = option.id === keys.provider;
          return (
            <Pressable
              key={option.id}
              accessibilityRole="button"
              accessibilityState={{ selected }}
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
          {keys.modelsLoading ? <Text style={styles.muted}>{t('form.modelsLoading')}</Text> : null}
          {!keys.modelsLoading && keys.modelsError ? (
            <>
              <Text style={styles.errorText}>{keys.modelsError}</Text>
              <TextInput
                value={keys.modelQuery}
                onChangeText={keys.editManualModel}
                placeholder={t('form.modelPlaceholder')}
                placeholderTextColor={colors.faint}
                autoCapitalize="none"
                autoCorrect={false}
                spellCheck={false}
                accessibilityLabel={t('form.modelLabel')}
                style={styles.input}
              />
              <Text style={styles.muted}>{t('form.manualModelHint')}</Text>
              <View style={styles.retry}>
                <GhostButton label={tCommon('retry')} onPress={keys.retryModels} />
              </View>
            </>
          ) : null}
          {!keys.modelsLoading && !keys.modelsError ? (
            <Combobox
              value={keys.modelQuery}
              onChangeText={keys.editModelQuery}
              options={modelOptions(keys.models)}
              onPick={keys.chooseModel}
              placeholder={t('form.modelPlaceholder')}
              chevron
              accessibilityLabel={t('form.modelLabel')}
            />
          ) : null}
          {!keys.modelsLoading && !keys.modelsError && keys.models.length === 0 ? (
            <Text style={styles.muted}>{t('form.modelsEmpty')}</Text>
          ) : null}
        </View>
      ) : null}

      {keys.model === null && keys.apiKey.trim().length >= MIN_AI_KEY_LENGTH && !keys.modelsLoading ? (
        <Text style={styles.muted}>{t('form.saveWithoutModel')}</Text>
      ) : null}

      {keys.error?.field === 'form' ? <Text style={styles.errorText}>{keys.error.message}</Text> : null}

      <View style={styles.actions}>
        {replacing ? <GhostButton label={tCommon('cancel')} onPress={keys.cancelReplace} /> : null}
        <IndigoButton
          label={keys.saving ? t('form.saving') : t('form.save')}
          onPress={() => void keys.save()}
          disabled={!canSave}
        />
      </View>
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
  label: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  hint: { color: colors.indigo3, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  okText: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  errorText: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: {
    minHeight: 40,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card2,
    paddingHorizontal: 14,
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
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginTop: 4, alignItems: 'center' },
});
