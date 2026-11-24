/**
 * Small transfer widgets shared by the register, the review list and the
 * payee screen: the ⇄ suggestion icon, the "auto · payee rule" label, the
 * match pill, a checkbox and the toast with Undo.
 */
import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import type { MatchKind } from './transfers.logic';
import type { TransferToastState } from './useTransfers';

/** ⇄ next to the category of a row that looks like a transfer; opens the popover at the press point. */
export function TransferIcon({ onOpen, highlighted }: { onOpen: (pageX: number, pageY: number) => void; highlighted?: boolean }) {
  return (
    <Pressable
      onPress={(e) => onOpen(e.nativeEvent.pageX, e.nativeEvent.pageY)}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={t('icon.label')}
      style={[styles.icon, highlighted && styles.iconOn]}>
      <Text style={styles.iconGlyph}>⇄</Text>
    </Pressable>
  );
}

/** A leg linked by a payee rule. */
export function TransferAutoLabel() {
  return (
    <Text style={styles.auto} numberOfLines={1}>
      {t('row.autoRule')}
    </Text>
  );
}

export function MatchPill({ kind }: { kind: MatchKind }) {
  const style = kind === 'sure' ? styles.pillSure : kind === 'choose' ? styles.pillChoose : styles.pillOne;
  const label = kind === 'sure' ? t('match.sure') : kind === 'choose' ? t('match.choose') : t('match.oneSide');
  return <Text style={[styles.pill, style]}>{label}</Text>;
}

export function TransferCheckbox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <Pressable
      onPress={onToggle}
      hitSlop={6}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={styles.checkCell}>
      <View style={[styles.checkbox, checked && styles.checkboxOn]}>
        {checked ? <Ionicons name="checkmark" size={12} color={colors.white} /> : null}
      </View>
    </Pressable>
  );
}

/** Bottom toast; with `undo` it carries an Undo button. */
export function TransferToast({ toast }: { toast: TransferToastState | null }) {
  if (!toast) return null;
  return (
    <View style={styles.toast} accessibilityLiveRegion="polite">
      <Text style={styles.toastText}>✓ {toast.text}</Text>
      {toast.undo ? (
        <Pressable onPress={toast.undo} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.toastUndo}>{t('toast.undo')}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

export const styles = StyleSheet.create({
  icon: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.blueBorder,
    backgroundColor: colors.bluePillBg,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  iconOn: { borderStyle: 'solid', borderColor: colors.blue },
  iconGlyph: { color: colors.blue, fontSize: 12, fontWeight: '800', lineHeight: 14 },
  auto: { color: colors.blue, fontSize: 10, flexShrink: 1 },
  pill: { fontSize: 11, borderRadius: 6, paddingVertical: 2, paddingHorizontal: 8, overflow: 'hidden', alignSelf: 'flex-start' },
  pillSure: { backgroundColor: colors.bluePillBg, color: colors.blue },
  pillChoose: { backgroundColor: colors.yellowPillBg, color: colors.yellowPillFg },
  pillOne: { backgroundColor: colors.grayPillBg, color: colors.grayPillFg },
  checkCell: { width: 26, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
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
  toast: {
    position: 'absolute',
    bottom: 18,
    alignSelf: 'center',
    zIndex: 50,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    maxWidth: '92%',
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    paddingVertical: 9,
    paddingHorizontal: 14,
  },
  toastText: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  toastUndo: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
