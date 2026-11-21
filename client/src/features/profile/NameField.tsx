/** Inline display-name editor: saves on blur / Enter, validates before sending. */
import { useEffect, useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

import { useUpdateMeMutation } from '@/profile/api';
import { checkDisplayName, NAME_MAX, type Me } from '@/profile/model';
import { t } from './i18n';
import { ui } from './ui';

export function NameField({ me }: { me: Me }) {
  const [update, { isLoading }] = useUpdateMeMutation();
  const [draft, setDraft] = useState(me.name ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // Follow server changes (e.g. another device) when the field isn't being edited.
  useEffect(() => setDraft(me.name ?? ''), [me.name]);

  async function commit() {
    const check = checkDisplayName(draft);
    if (!check.ok) return setError(check.error);
    setError(null);
    if (check.value === (me.name ?? '')) return setDraft(check.value);
    setDraft(check.value);
    try {
      await update({ name: check.value }).unwrap();
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      setError((e as { message?: string }).message ?? t('name.saveFailed'));
      setDraft(me.name ?? '');
    }
  }

  return (
    <View style={ui.card}>
      <Text style={ui.sectionTitle}>{t('name.title')}</Text>
      <TextInput
        value={draft}
        onChangeText={(text) => {
          setDraft(text);
          setSaved(false);
          if (error) setError(null);
        }}
        onBlur={commit}
        onSubmitEditing={commit}
        maxLength={NAME_MAX + 20}
        placeholder={t('name.placeholder')}
        placeholderTextColor={colors.faint}
        returnKeyType="done"
        accessibilityLabel={t('name.label')}
        style={[styles.input, error ? styles.inputError : null]}
      />
      <View style={styles.footer}>
        {error ? <Text style={ui.error}>{error}</Text> : <Text style={ui.muted}>{isLoading ? t('name.saving') : saved ? t('name.saved') : t('name.help')}</Text>}
      </View>
      <View style={styles.readonly}>
        <Text style={ui.sectionTitle}>{t('name.emailTitle')}</Text>
        <Text style={styles.email} selectable>
          {me.email}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  input: {
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.card10,
    color: colors.text,
    fontSize: 16,
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  inputError: { borderColor: colors.red },
  footer: { minHeight: 18 },
  readonly: { gap: 6, marginTop: 4 },
  email: { color: colors.muted, fontSize: 15 },
});
