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
}: {
  message: string;
  /** Omit both to show a plain message with no action. */
  actionLabel?: string;
  onAction?: () => void;
  /** Glyph before the message; null for none (errors). */
  leading?: string | null;
}) {
  return (
    <View style={styles.toast} accessibilityLiveRegion="polite">
      <Text style={styles.text}>
        {leading ? `${leading} ` : ''}
        {message}
      </Text>
      {actionLabel && onAction ? (
        <Pressable onPress={onAction} accessibilityRole="button" hitSlop={6}>
          <Text style={styles.action}>{actionLabel}</Text>
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
  action: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
