import { Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from 'react-native';

import { colors, radius } from '@/ui/theme';

export function IndigoButton({ label, onPress, disabled, style }: { label: string; onPress?: () => void; disabled?: boolean; style?: StyleProp<ViewStyle> }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}
      style={[styles.btnIndigo, style, disabled && styles.btnIndigoOff]}>
      <Text style={[styles.btnIndigoText, disabled && styles.btnIndigoTextOff]}>{label}</Text>
    </Pressable>
  );
}

export function GhostButton({
  label,
  onPress,
  style,
  disabled,
}: {
  label: string;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={[styles.btnGhost, style, disabled && styles.btnIndigoOff]}
      accessibilityRole="button"
      accessibilityState={{ disabled: !!disabled }}>
      <Text style={styles.btnGhostText}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  btnIndigo: {
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 9,
    paddingHorizontal: 16,
    alignItems: 'center',
  },
  btnIndigoText: { color: colors.white, fontWeight: '700', fontSize: 13 },
  btnIndigoOff: { opacity: 0.5 },
  btnIndigoTextOff: { opacity: 0.8 },
  btnGhost: {
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 13,
    alignItems: 'center',
  },
  btnGhostText: { color: colors.text, fontWeight: '600', fontSize: 13 },
});
