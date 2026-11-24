/** Register filter chips: All · Needs category · Looks like a transfer · Transfers, with counts. */
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import type { RegisterChip } from './transfers.logic';

export function TransferChips({
  chip,
  counts,
  onChange,
}: {
  chip: RegisterChip;
  counts: Record<Exclude<RegisterChip, 'all'>, number>;
  onChange: (chip: RegisterChip) => void;
}) {
  const items: { key: RegisterChip; label: string; count?: number }[] = [
    { key: 'all', label: t('chips.all') },
    { key: 'needsCategory', label: t('chips.needsCategory'), count: counts.needsCategory },
    { key: 'suggested', label: t('chips.suggested'), count: counts.suggested },
    { key: 'transfers', label: t('chips.transfers'), count: counts.transfers },
  ];
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.scroll} contentContainerStyle={styles.row} accessibilityLabel={t('chips.label')}>
      {items.map((it) => {
        const on = chip === it.key && it.key !== 'all';
        return (
          <Pressable
            key={it.key}
            onPress={() => onChange(on ? 'all' : it.key)}
            accessibilityRole="button"
            accessibilityState={{ selected: chip === it.key }}
            style={[styles.chip, on && styles.chipOn]}>
            <Text style={[styles.label, on && styles.labelOn]}>{it.label}</Text>
            {it.count !== undefined ? (
              <View style={[styles.n, on && styles.nOn]}>
                <Text style={[styles.nText, on && styles.labelOn]}>{it.count}</Text>
              </View>
            ) : null}
            {on ? (
              <Text style={styles.labelOn} accessibilityLabel={t('chips.clear')}>
                ✕
              </Text>
            ) : null}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 0, flexShrink: 0 },
  row: { flexDirection: 'row', gap: 8, paddingHorizontal: 20, paddingVertical: 8 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  chipOn: { borderColor: colors.blue, backgroundColor: colors.bluePillBg },
  label: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  labelOn: { color: colors.blue, fontSize: 12, fontWeight: '600' },
  n: { backgroundColor: colors.grayPillBg, borderRadius: radius.pill, paddingHorizontal: 7 },
  nOn: { backgroundColor: colors.blueSoft },
  nText: { color: colors.muted, fontSize: 11 },
});
