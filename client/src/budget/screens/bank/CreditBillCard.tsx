/**
 * Bill hero + limit bar for a CREDIT account on the bank Overview: current bill
 * with its due pill, used/limit progress bar and the remaining availability.
 * Sections degrade independently when the issuer omits data.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { CreditView } from '../../model/banks/connections';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { colors, radius } from '../../ui/theme';

export function CreditBillCard({ view }: { view: CreditView }) {
  const { formatMoney } = useMoneyFormat();
  const { billCents, due, usedCents, limitCents, availableCents, usedPct } = view;
  const showBar = usedCents != null && limitCents != null;
  return (
    <View style={styles.wrap}>
      {billCents != null || due ? (
        <View style={styles.row}>
          <Text style={styles.label}>{billCents != null ? 'CURRENT BILL' : 'BILL'}</Text>
          {due ? (
            <View style={styles.duePill}>
              <Text style={styles.dueText}>{`Due ${due}`}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
      {billCents != null ? <Text style={styles.bill}>{formatMoney(billCents)}</Text> : null}
      {showBar ? (
        <View style={styles.limit}>
          <View style={styles.track}>
            <View style={[styles.fill, { width: `${usedPct ?? 0}%` }]} />
          </View>
          <View style={styles.row}>
            <Text style={styles.used}>
              {formatMoney(usedCents)}
              <Text style={styles.muted}>{usedPct != null ? ` used · ${usedPct}%` : ' used'}</Text>
            </Text>
            <Text style={styles.muted}>{`of ${formatMoney(limitCents)}`}</Text>
          </View>
          {availableCents != null ? <Text style={styles.available}>{`${formatMoney(availableCents)} available`}</Text> : null}
        </View>
      ) : limitCents != null ? (
        <Text style={styles.muted}>{`Limit ${formatMoney(limitCents)}`}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  duePill: { backgroundColor: colors.yellowPillBg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  dueText: { color: colors.yellowPillFg, fontSize: 12, fontWeight: '700' },
  bill: { color: colors.text, fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  limit: { gap: 6 },
  track: { height: 8, borderRadius: radius.pill, backgroundColor: colors.border2, overflow: 'hidden' },
  fill: { height: 8, borderRadius: radius.pill, backgroundColor: colors.indigo2 },
  used: { color: colors.text, fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'] },
  muted: { color: colors.muted, fontSize: 13, fontWeight: '400' },
  available: { color: colors.greenPillFg, fontSize: 13, fontWeight: '600' },
});
