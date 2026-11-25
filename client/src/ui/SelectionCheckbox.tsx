/**
 * SelectionCheckbox: the 17px bordered row checkbox shared by every table
 * (register rows and header, transfer popover), filled when checked.
 */

import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import { colors } from '@/ui/theme';

export function SelectionCheckbox({
  checked,
  onToggle,
  label,
  disabled,
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
  /** Reconciled rows are locked (syscd-app-lqu): renders but never toggles. */
  disabled?: boolean;
}) {
  return (
    <Pressable
      onPress={disabled ? undefined : onToggle}
      disabled={disabled}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled }}
      accessibilityLabel={label}
      style={styles.checkCell}>
      <View style={[styles.checkbox, checked && styles.checkboxOn, disabled && styles.checkboxLocked]}>
        {checked ? <Ionicons name="checkmark" size={12} color={colors.white} /> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  checkCell: { width: 26, alignItems: 'center', justifyContent: 'center', flexShrink: 0, marginRight: 4 },
  checkbox: {
    width: 17,
    height: 17,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.faint,
    alignItems: 'center',
    justifyContent: 'center',
  },
  checkboxOn: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  checkboxLocked: { opacity: 0.35 },
});
