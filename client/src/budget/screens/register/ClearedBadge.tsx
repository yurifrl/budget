/**
 * ClearedBadge — the register's cleared-status indicator: a single-color icon
 * in a fixed-size slot, so every row keeps the same height and the mark never
 * wraps. Green check = cleared, faint circle = uncleared, indigo lock =
 * reconciled (mirrors the balance buckets: reconciled counts as cleared).
 *
 * When `onApprove` is given the slot becomes the row's compact approve
 * control (YNAB's ✓✓), letting unapproved rows keep the exact same footprint
 * as cleared ones.
 *
 * When `onToggle` is given the slot becomes the cleared/uncleared switch:
 * tapping flips between the two states (reconciled rows stay read-only).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

import type { ClearedStatus } from '../../domain/types';
import { colors } from '../../ui/theme';

const GLYPH: Record<ClearedStatus, keyof typeof Ionicons.glyphMap> = {
  uncleared: 'ellipse-outline',
  cleared: 'checkmark-circle',
  reconciled: 'lock-closed',
};

const TINT: Record<ClearedStatus, string> = {
  uncleared: colors.faint,
  cleared: colors.green,
  reconciled: colors.indigo2,
};

/** Press event shape both RN-web SyntheticEvent and the native responder event satisfy. */
interface BadgePressEvent {
  stopPropagation: () => void;
}

export function ClearedBadge({
  status,
  onApprove,
  onToggle,
  compact,
}: {
  status: ClearedStatus;
  onApprove?: () => void;
  onToggle?: () => void;
  /** Phone variant: a letter "C" replaces the icon marks. */
  compact?: boolean;
}) {
  // The badge sits inside the row Pressable — stop the press there so a
  // toggle doesn't also open the editor (same pattern as the ⋯ menu button).
  const withStopPropagation = (e: BadgePressEvent, action: () => void) => {
    e.stopPropagation();
    action();
  };
  if (onApprove) {
    return (
      <Pressable
        onPress={(e) => withStopPropagation(e, onApprove)}
        style={styles.slot}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel="Approve transaction">
        {compact ? (
          <Text style={[styles.compactC, { color: colors.indigo2 }]}>C</Text>
        ) : (
          <Ionicons name="checkmark-done" size={15} color={colors.indigo2} />
        )}
      </Pressable>
    );
  }
  if (onToggle && status !== 'reconciled') {
    const cleared = status === 'cleared';
    return (
      <Pressable
        onPress={(e) => withStopPropagation(e, onToggle)}
        style={styles.slot}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityState={{ checked: cleared }}
        accessibilityLabel={cleared ? 'Mark transaction uncleared' : 'Clear transaction'}>
        {compact ? (
          <Text style={[styles.compactC, cleared ? { color: colors.green } : { color: colors.faint }]}>C</Text>
        ) : (
          <Ionicons name={GLYPH[status]} size={15} color={TINT[status]} />
        )}
      </Pressable>
    );
  }
  return (
    <View style={styles.slot} accessibilityLabel={`Transaction ${status}`}>
      {compact ? (
        <Text
          style={[
            styles.compactC,
            status === 'reconciled'
              ? { color: colors.indigo2 }
              : status === 'cleared'
                ? { color: colors.green }
                : { color: colors.faint },
          ]}>
          C
        </Text>
      ) : (
        <Ionicons name={GLYPH[status]} size={15} color={TINT[status]} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  slot: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  // Compact (phone) letter mark: fixed weight so C reads at a glance.
  compactC: {
    fontSize: 14,
    fontWeight: '700',
  },
});
