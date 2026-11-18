/**
 * AmountPill — the register's signed amount chip: red "−" pill for outflow,
 * green "+" pill for inflow. Takes signed cents (negative = outflow).
 */

import { StyleSheet, Text, View } from 'react-native';

import { useMoneyFormat } from './moneyFormat';
import { colors } from '@/ui/theme';

export function AmountPill({ cents }: { cents: number }) {
  const { formatMoney } = useMoneyFormat();
  const out = cents < 0;
  return (
    <View style={[styles.box, out ? styles.out : styles.in]}>
      <Text style={[styles.glyph, out ? styles.outFg : styles.inFg]}>{out ? '−' : '+'}</Text>
      <Text style={[styles.value, out ? styles.outFg : styles.inFg]} numberOfLines={1}>
        {formatMoney(Math.abs(cents))}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 999,
  },
  out: { backgroundColor: colors.redPillBg },
  in: { backgroundColor: colors.greenPillBg },
  glyph: { fontSize: 13, fontWeight: '600' },
  value: { fontSize: 13, fontVariant: ['tabular-nums'] },
  outFg: { color: colors.redFg },
  inFg: { color: colors.greenPillFg },
});
