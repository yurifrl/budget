/** "Change password" in the profile: current + new password, for accounts that have one. */
import { useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { ErrorNotice, FIELD_HINTS, newPasswordHint, PasswordField } from '@/features/auth';
import { colors } from '@/ui/theme';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';
import { ui } from './ui';
import { useChangePassword } from './useChangePassword';

export function ChangePasswordCard({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const { busy, error, submit, clearError } = useChangePassword(email);

  const close = () => {
    setOpen(false);
    setCurrent('');
    setNext('');
    setConfirm('');
    clearError();
  };

  const save = async () => {
    if (busy) return;
    if (await submit(current, next, confirm)) {
      close();
      setDone(true);
    }
  };

  if (!open) {
    return (
      <View style={styles.wrap}>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDone(false);
            setOpen(true);
          }}
          style={ui.button}>
          <Text style={ui.buttonText}>{t('password.open')}</Text>
        </Pressable>
        {done ? <Text style={ui.muted}>{t('password.done')}</Text> : null}
      </View>
    );
  }

  const hint = newPasswordHint(next, email);
  return (
    <View style={ui.card}>
      <Text style={ui.sectionTitle}>{t('password.title')}</Text>
      <PasswordField label={t('password.current')} value={current} onChangeText={setCurrent} secureTextEntry {...FIELD_HINTS.current} />
      <PasswordField label={t('password.new')} value={next} onChangeText={setNext} secureTextEntry {...FIELD_HINTS.new} />
      {hint ? <Text style={ui.muted}>{hint}</Text> : null}
      <PasswordField
        label={t('password.repeat')}
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        returnKeyType="go"
        onSubmitEditing={() => void save()}
        {...FIELD_HINTS.new}
      />
      {error ? <ErrorNotice text={error} /> : null}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" onPress={close} style={[ui.button, styles.grow]}>
          <Text style={ui.buttonText}>{tCommon('cancel')}</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: busy, busy }}
          disabled={busy}
          onPress={() => void save()}
          style={[ui.button, ui.buttonPrimary, styles.grow, busy && ui.buttonDisabled]}>
          {busy ? <ActivityIndicator size="small" color={colors.white} /> : <Text style={ui.buttonText}>{t('password.save')}</Text>}
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: { flexDirection: 'row', gap: 12 },
  grow: { flex: 1 },
});
