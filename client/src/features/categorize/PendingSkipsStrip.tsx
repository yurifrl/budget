/**
 * The skips still waiting for their timer, as a compact strip for the Bundles
 * view (One by one shows them in its queue list): each with its countdown and
 * its own Undo, so a skip made in One by one never runs out unseen.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';

import type { UndoEntry } from './accept.logic';
import { t } from './i18n';
import { secondsLeft } from './oneByOne.logic';
import { useNow } from './useNow';

export function PendingSkipsStrip({
  skips,
  onCancel,
}: {
  skips: readonly Extract<UndoEntry, { kind: 'skip' }>[];
  onCancel: (transactionId: string) => void;
}) {
  const now = useNow(skips.length > 0, skips.map((s) => s.sendAt).join(','));
  if (skips.length === 0) return null;
  return (
    <View style={styles.strip} accessibilityLiveRegion="polite">
      <Text style={styles.title}>{t('strip.title')}</Text>
      {skips.map((skip) => (
        <View key={skip.seq} style={styles.line}>
          <Text style={styles.text} numberOfLines={1}>
            {t('strip.line', { subject: skip.item.subject, seconds: secondsLeft(skip.sendAt, now) })}
          </Text>
          <Pressable
            onPress={() => onCancel(skip.item.transactionId)}
            accessibilityRole="button"
            accessibilityLabel={`${t('undo')} ${skip.item.subject}`}
            hitSlop={6}>
            <Text style={styles.undo}>{t('undo')}</Text>
          </Pressable>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: {
    gap: 6,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.yellowPillFg,
    borderRadius: radius.sm,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  title: { color: colors.yellowPillFg, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 },
  line: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  text: { color: colors.text, fontSize: 13, flex: 1 },
  undo: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
