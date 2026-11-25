/**
 * The AI-unavailable state of the Categorize page (mock ev-9784fa): the precise
 * reason is already in the header; here the person either adds a key or keeps
 * categorizing by hand.
 */

import { StyleSheet, Text, View } from 'react-native';

import { GhostButton, IndigoButton } from '@/ui/bits';
import { IconSymbol } from '@/ui/icon-symbol';
import { colors, radius } from '@/ui/theme';

import { t } from './i18n';

export function EmptyState({
  reason,
  count,
  onAddKey,
  onByHand,
}: {
  reason: string;
  count: number | undefined;
  onAddKey: () => void;
  onByHand: () => void;
}) {
  return (
    <View style={styles.wrap}>
      <View style={styles.iconCircle}>
        <IconSymbol name="key.fill" size={24} color={colors.indigo3} />
      </View>
      <Text style={styles.title}>{t('empty.title')}</Text>
      <Text style={styles.body}>{t('empty.body')}</Text>
      <Text style={styles.reason}>{reason}</Text>
      <View style={styles.actions}>
        <IndigoButton label={t('empty.addKey')} onPress={onAddKey} />
        <GhostButton label={t('empty.byHand')} onPress={onByHand} />
      </View>
      {count != null ? <Text style={styles.footnote}>{t('empty.footnote', { count })}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', gap: 12, paddingVertical: 64, paddingHorizontal: 24, maxWidth: 640, alignSelf: 'center' },
  iconCircle: {
    width: 56,
    height: 56,
    borderRadius: radius.r,
    backgroundColor: colors.indigoSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { color: colors.text, fontSize: 22, fontWeight: '800', textAlign: 'center', marginTop: 6 },
  body: { color: colors.muted, fontSize: 13, lineHeight: 20, textAlign: 'center' },
  reason: { color: colors.faint, fontSize: 12, textAlign: 'center' },
  actions: { flexDirection: 'row', gap: 10, marginTop: 8, flexWrap: 'wrap', justifyContent: 'center' },
  footnote: { color: colors.faint, fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 4 },
});
