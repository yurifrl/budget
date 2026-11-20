/**
 * The two forms of the password flow on the landing page: e-mail + password,
 * and the forced "choose a new password" step after a temporary password.
 * Field values are local state only (never redux, storage or a URL); the
 * verdicts come from password.logic.ts.
 */
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '@/ui/theme';
import { checkLogin, checkNewPassword, FIELD_HINTS, newPasswordHint } from './password.logic';
import { PasswordField, type InputRef } from './PasswordField';
import type { PasswordSignIn } from './usePasswordSignIn';

export function PasswordSignInForm({ flow, primary }: { flow: PasswordSignIn; primary: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const passwordRef = useRef<InputRef>(null);

  const submit = async () => {
    if (flow.busy) return;
    const check = checkLogin(email, password);
    if (!check.ok) return setLocal(check.error);
    setLocal(null);
    await flow.signIn(check.value.email, check.value.password);
    setPassword('');
  };
  const error = local ?? flow.error;

  return (
    <View style={styles.form}>
      <PasswordField
        label="E-mail"
        value={email}
        onChangeText={setEmail}
        returnKeyType="next"
        onSubmitEditing={() => passwordRef.current?.focus()}
        {...FIELD_HINTS.email}
      />
      <PasswordField
        inputRef={passwordRef}
        label="Password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        invalid={error !== null}
        {...FIELD_HINTS.current}
      />
      {error ? <ErrorNotice text={error} /> : null}
      <SubmitButton label="Sign in with e-mail" primary={primary} busy={flow.busy} onPress={() => void submit()} />
    </View>
  );
}

export function NewPasswordForm({ flow, email }: { flow: PasswordSignIn; email: string }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [local, setLocal] = useState<string | null>(null);
  const confirmRef = useRef<InputRef>(null);

  const submit = async () => {
    if (flow.busy) return;
    const check = checkNewPassword(password, confirm, email);
    if (!check.ok) return setLocal(check.error);
    setLocal(null);
    await flow.choose(check.value);
  };
  const hint = newPasswordHint(password, email);
  const error = local ?? flow.error;

  return (
    <View style={styles.form}>
      <Text style={styles.account}>{email}</Text>
      <PasswordField
        label="New password"
        value={password}
        onChangeText={setPassword}
        secureTextEntry
        returnKeyType="next"
        onSubmitEditing={() => confirmRef.current?.focus()}
        {...FIELD_HINTS.new}
      />
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      <PasswordField
        inputRef={confirmRef}
        label="Repeat the new password"
        value={confirm}
        onChangeText={setConfirm}
        secureTextEntry
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
        {...FIELD_HINTS.new}
      />
      {error ? <ErrorNotice text={error} /> : null}
      <SubmitButton label="Set password and sign in" primary busy={flow.busy} onPress={() => void submit()} />
      <Pressable accessibilityRole="button" onPress={flow.cancel} style={styles.link}>
        <Text style={styles.linkText}>Back to sign in</Text>
      </Pressable>
    </View>
  );
}

export function ErrorNotice({ text }: { text: string }) {
  return (
    <View accessibilityRole="alert" style={styles.notice}>
      <Text style={styles.noticeText}>{text}</Text>
    </View>
  );
}

function SubmitButton({ label, primary, busy, onPress }: { label: string; primary: boolean; busy: boolean; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: busy, busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.button, primary ? styles.buttonPrimary : styles.buttonSecondary, busy && styles.buttonBusy]}>
      {busy ? <ActivityIndicator size="small" color={colors.white} /> : <Text style={styles.buttonText}>{label}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  form: { gap: 12 },
  account: { color: colors.muted, fontSize: 15 },
  hint: { color: colors.muted, fontSize: 13, marginTop: -4 },
  notice: { backgroundColor: colors.redPillBg, borderRadius: radius.card10, paddingVertical: 12, paddingHorizontal: 14 },
  noticeText: { color: colors.redFg, fontSize: 15, lineHeight: 21 },
  button: { minHeight: 50, paddingHorizontal: 28, borderRadius: radius.card10, alignItems: 'center', justifyContent: 'center', marginTop: spacing.sm / 2 },
  buttonPrimary: { backgroundColor: colors.indigo },
  buttonSecondary: { backgroundColor: colors.card2 },
  buttonBusy: { opacity: 0.7 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '700' },
  link: { alignItems: 'center', paddingVertical: 8 },
  linkText: { color: colors.indigo3, fontSize: 15, fontWeight: '600' },
});
