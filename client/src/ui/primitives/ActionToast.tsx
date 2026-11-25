/**
 * Bottom toast shared by the register's transfer actions and Categorize: one
 * line of text, an optional action (Undo) and the same placement and styling
 * everywhere. The caller owns visibility and the dismiss timer and supplies
 * already-translated text; this component never reads a feature catalog.
 */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

export function ActionToast({
  message,
  actionLabel,
  onAction,
  leading = '✓',
  actionKey,
}: {
  message: string;
  /** Omit both to show a plain message with no action. */
  actionLabel?: string;
  onAction?: () => void;
  /** Glyph before the message; null for none (errors). */
  leading?: string | null;
  /** The keyboard shortcut of the action ("Z"), shown as a key cap; web only, omit elsewhere. */
  actionKey?: string;
}) {
  return (
    <View style={styles.toast} accessibilityLiveRegion="polite">
      <Text style={styles.text}>
        {leading ? `${leading} ` : ''}
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" hitSlop={6} style={styles.actionRow}>
          <Text style={styles.action}>{actionLabel}</Text>
          {actionKey ? (
            <View style={styles.keyCap}>
              <Text style={styles.keyCapText}>{actionKey}</Text>
            </View>
          ) : null}
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
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
  text: { color: colors.text, fontSize: 13, fontWeight: '600', flexShrink: 1 },
  actionRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  keyCap: {
    minWidth: 18,
    height: 18,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: 5,
  },
  keyCapText: { color: colors.muted, fontSize: 10.5, fontWeight: '700' },
  action: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
