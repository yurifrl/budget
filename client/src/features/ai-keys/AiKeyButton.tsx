/**
 * One button of the AI key cards: neutral by default, indigo for the primary
 * action, red-framed for Remove. Renders on web and iOS alike; a busy button
 * is disabled and shows the progress label its caller passes.
 */

import { Pressable, StyleSheet, Text } from 'react-native';

import { colors, radius } from '@/ui/theme';

export function AiKeyButton({
  label,
  onPress,
  primary,
  danger,
  busy,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
  danger?: boolean;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!busy, busy: !!busy }}
      disabled={busy}
      onPress={onPress}
      style={[styles.btn, primary && styles.primary, danger && styles.danger, busy && styles.busy]}>
      <Text style={[styles.text, primary && styles.primaryText, danger && !primary && styles.dangerText]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
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
  primary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  danger: { borderColor: colors.red },
  busy: { opacity: 0.6 },
  text: { color: colors.text, fontSize: 14, fontWeight: '700' },
  primaryText: { color: colors.white },
  dangerText: { color: colors.redFg },
});
