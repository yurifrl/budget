/**
 * The "Leaving uncategorized" strip, shared by both views: the rows the person
 * moved out of the list with S or "Leave uncategorized". There is no countdown
 * and nothing is sent on a timer: each row has its own Undo, and the Done button
 * (reachable by Tab; it has no shortcut letter) sends them all, naming how many
 * rows will leave the list for everyone in the budget.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import { IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';

import type { SkipEntry } from './accept.logic';
import { t } from './i18n';

export function PendingSkipsStrip({
  skips,
  onCancel,
  onDone,
  busy,
}: {
  skips: readonly SkipEntry[];
  onCancel: (transactionId: string) => void;
  onDone: () => void;
  /** A request is in flight: Done waits. */
  busy: boolean;
}) {
  if (skips.length === 0) return null;
  return (
    <View style={styles.strip} accessibilityLiveRegion="polite">
      <View style={styles.head}>
        <View style={styles.headText}>
          <Text style={styles.title}>{t('strip.title')}</Text>
          <Text style={styles.hint}>{t('strip.hint')}</Text>
        </View>
        <IndigoButton
          label={t('strip.done', { count: skips.length })}
          onPress={onDone}
          disabled={busy}
          style={styles.done}
        />
      </View>
      {skips.map((skip) => (
        <View key={skip.seq} style={styles.line}>
          <Text style={styles.text} numberOfLines={1}>
            {skip.item.subject}
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
  head: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  headText: { flexGrow: 1, flexBasis: 320, gap: 2 },
  title: { color: colors.yellowPillFg, fontSize: 10.5, fontWeight: '700', letterSpacing: 0.6 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17 },
  done: { paddingVertical: 8, paddingHorizontal: 16 },
  // Undo sits beside the text it belongs to, not at the far edge of a wide strip.
  line: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  text: { color: colors.text, fontSize: 13, flexShrink: 1 },
  undo: { color: colors.indigo3, fontSize: 13, fontWeight: '700' },
});
