/**
 * A paused bank: why (the server's status message) and what to do, with a
 * button to "Your Pluggy keys". `compact` is the Linked banks row; the full
 * one sits on the bank's page.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConnectionJson } from '@/budget/data/connections';
import { colors, radius } from '@/ui/theme';
import { pausedGuidance } from './pluggyKeys.logic';

export function PausedNotice({
  row,
  compact,
  onOpenKeys,
}: {
  row: Pick<ConnectionJson, 'status' | 'status_message' | 'status_message_code' | 'key_source'>;
  compact?: boolean;
  onOpenKeys: () => void;
}) {
  const guidance = pausedGuidance(row);
  if (!guidance) return null;
  return (
    <View style={[styles.box, compact && styles.compact]}>
      <Text style={styles.why} numberOfLines={compact ? 3 : undefined}>
        {guidance.why}
      </Text>
      <Text style={styles.todo} numberOfLines={compact ? 3 : undefined}>
        {guidance.todo}
      </Text>
      <Pressable accessibilityRole="button" onPress={onOpenKeys} hitSlop={6} style={styles.action}>
        <Text style={styles.actionText}>{`${guidance.actionLabel} ›`}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  box: { backgroundColor: colors.yellowPillBg, borderRadius: radius.sm, padding: 12, gap: 6 },
  compact: { padding: 8, marginTop: 4 },
  why: { color: colors.yellowPillFg, fontSize: 13, lineHeight: 18, fontWeight: '600' },
  todo: { color: colors.text, fontSize: 13, lineHeight: 18 },
  action: { alignSelf: 'flex-start', paddingVertical: 4 },
  actionText: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
