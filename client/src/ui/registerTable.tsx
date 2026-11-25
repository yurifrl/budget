/**
 * Register table look: header/row/cell styles and the signed amount box
 * (red "−" out, green "+" in).
 */

import { StyleSheet, Text, View } from 'react-native';

import { useMoneyFormat } from './moneyFormat';
import { colors, radius } from '@/ui/theme';

/** Signed amount pill (import-style). `amount` is the absolute value in cents. */
export function SignedAmountBox({ amount, out }: { amount: number; out: boolean }) {
  const { formatMoney } = useMoneyFormat();
  return (
    <View style={[styles.amtBox, out ? styles.amtOut : styles.amtIn]}>
      <Text style={[styles.amtGlyph, out ? styles.amtOutGlyph : styles.amtInGlyph]}>{out ? '−' : '+'}</Text>
      <Text style={[styles.amtValue, out ? styles.amtOutValue : styles.amtInValue]} numberOfLines={1}>
        {formatMoney(amount)}
      </Text>
    </View>
  );
}

export const tableStyles = StyleSheet.create({
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  headText: { color: colors.faint, fontSize: 11, letterSpacing: 0.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  text: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
});

const styles = StyleSheet.create({
  amtBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 1,
    paddingHorizontal: 5,
    maxWidth: 118,
  },
  amtOut: { borderColor: colors.red, backgroundColor: colors.redPillBg },
  amtIn: { borderColor: colors.green, backgroundColor: colors.greenPillBg },
  amtGlyph: { fontSize: 13, fontWeight: '600' },
  amtOutGlyph: { color: colors.redFg },
  amtInGlyph: { color: colors.greenPillFg },
  amtValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  amtOutValue: { color: colors.redFg },
  amtInValue: { color: colors.greenPillFg },
});
