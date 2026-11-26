/**
 * Small transfer widgets shared by the register and the review list: the
 * ⇄ suggestion icon, the "auto · payee rule" label (a leg an old per-payee
 * rule linked), the match pill and the toast with Undo.
 */
import { Pressable, StyleSheet, Text } from 'react-native';

import { ActionToast, TagPill } from '@/ui/bits';
import { colors } from '@/ui/theme';
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
  const tone = kind === 'sure' ? 'blue' : kind === 'choose' || kind === 'confirm' ? 'yellow' : 'gray';
  const label =
    kind === 'sure' ? t('match.sure') : kind === 'confirm' ? t('match.confirm') : kind === 'choose' ? t('match.choose') : t('match.oneSide');
  return <TagPill label={label} tone={tone} />;
}

/** Bottom toast; with `undo` it carries an Undo button (shared ActionToast). */
export function TransferToast({ toast }: { toast: TransferToastState | null }) {
  if (!toast) return null;
  return <ActionToast message={toast.text} actionLabel={toast.undo ? t('toast.undo') : undefined} onAction={toast.undo} />;
}

const styles = StyleSheet.create({
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
});
