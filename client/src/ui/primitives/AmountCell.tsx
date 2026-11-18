import { StyleSheet, type StyleProp, type TextStyle } from 'react-native';

import type { Cents } from '@/domain/types';
import { colors } from '@/ui/theme';
import { MoneyInput } from './MoneyInput';
import { amountCellPatch, amountCellValue } from './moneyDraft.logic';

/**
 * Amount (shared with the register and the import preview): one signed input
 * — "-115,00" (outflow, red) / "+115,00" or bare digits (inflow, green). The
 * typed operand IS the sign; a bare number saves as positive. No direction
 * toggle, no box — the input carries the standard outlined style. The optional
 * `style` sizes the field (e.g. a flexed register column).
 */
export function AmountCell({
  outflowCents,
  inflowCents,
  onChange,
  style,
}: {
  outflowCents: Cents;
  inflowCents: Cents;
  onChange: (patch: { outflowCents: Cents; inflowCents: Cents }, rawText?: string) => void;
  style?: StyleProp<TextStyle>;
}) {
  // Storage sign in the field: outflow renders "−55,90" so editing digits
  // re-commits as an outflow (next < 0), not silently flipping to inflow.
  const { isOutflow, cents } = amountCellValue(outflowCents, inflowCents);
  return (
    <MoneyInput
      signed
      allowEmpty
      cents={cents}
      onCommit={(next, rawText) => onChange(amountCellPatch(next), rawText)}
      style={[styles.amountValue, cents !== 0 && (isOutflow ? styles.amountOutValue : styles.amountInValue), style]}
    />
  );
}

const styles = StyleSheet.create({
  amountValue: { flex: 1, minWidth: 0, textAlign: 'right', fontSize: 13, paddingVertical: 4, paddingHorizontal: 6 },
  amountOutValue: { color: colors.redFg },
  amountInValue: { color: colors.greenPillFg },
});
