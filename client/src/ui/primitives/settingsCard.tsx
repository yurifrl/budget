/**
 * Card shell and rows shared by the credential screens ("Your Pluggy keys",
 * "AI key"): the card surface, its section label, key/value rows, action
 * buttons, the inline danger confirm, and the loading / failed cards. The
 * styles are the Pluggy card's original values, extracted unchanged so both
 * screens look and behave the same. Labels are passed in by the feature (its
 * own catalog), never translated here.
 */

import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

export function SettingsCard({ children, center }: { children: ReactNode; center?: boolean }) {
  return <View style={[styles.card, center && styles.center]}>{children}</View>;
}

export function SettingsCardSection({ label }: { label: string }) {
  return <Text style={text.section}>{label}</Text>;
}

/** A label/value line. `lines` caps the value (Pluggy's rows are single-line). */
export function SettingsCardRow({ label, value, lines = 1 }: { label: string; value: string; lines?: number }) {
  return (
    <View style={styles.kv}>
      <Text style={styles.kvLabel}>{label}</Text>
      <Text style={styles.kvValue} selectable numberOfLines={lines}>
        {value}
      </Text>
    </View>
  );
}

export function SettingsCardButton({
  label,
  onPress,
  primary,
  danger,
  busy,
  disabled,
  grow,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  grow?: boolean;
}) {
  const off = !!busy || !!disabled;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: off, busy: !!busy }}
      disabled={off}
      onPress={onPress}
      style={[styles.btn, primary && styles.btnPrimary, danger && styles.btnDanger, grow && styles.grow, off && styles.btnBusy]}>
      <Text style={[text.btn, danger && !primary && text.btnDanger]}>{label}</Text>
    </Pressable>
  );
}

export function SettingsCardActions({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return <View style={[styles.row, wrap && styles.rowWrap]}>{children}</View>;
}

/** The inline "remove? Cancel / Remove" box of the saved state. */
export function SettingsConfirm({
  message,
  cancelLabel,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  message: string;
  cancelLabel: string;
  confirmLabel: string;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <View style={styles.confirm}>
      <Text style={text.body}>{message}</Text>
      <View style={styles.row}>
        <SettingsCardButton label={cancelLabel} onPress={onCancel} grow />
        <SettingsCardButton label={confirmLabel} danger busy={busy} onPress={onConfirm} grow />
      </View>
    </View>
  );
}

export function SettingsCardLoading() {
  return (
    <SettingsCard center>
      <ActivityIndicator color={colors.indigo2} />
    </SettingsCard>
  );
}

export function SettingsCardFailed({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry: () => void }) {
  return (
    <SettingsCard>
      <Text style={text.error}>{message}</Text>
      <SettingsCardButton label={retryLabel} onPress={onRetry} />
    </SettingsCard>
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
  kv: { flexDirection: 'row', justifyContent: 'space-between', gap: 12, paddingVertical: 4 },
  kvLabel: { color: colors.muted, fontSize: 14 },
  kvValue: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  confirm: { gap: 10, backgroundColor: colors.redPillBg, borderRadius: radius.sm, padding: 12 },
  row: { flexDirection: 'row', gap: 10, marginTop: 4 },
  rowWrap: { flexWrap: 'wrap', alignItems: 'center' },
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
});

const text = StyleSheet.create({
  section: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  body: { color: colors.text, fontSize: 14, lineHeight: 20 },
  muted: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  ok: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
  error: { color: colors.redFg, fontSize: 13, lineHeight: 18 },
  btn: { color: colors.text, fontSize: 14, fontWeight: '700' },
  btnDanger: { color: colors.redFg },
});

/** The text styles both credential cards use inline (muted hint, success, error, body). */
export const settingsCardText = text;
