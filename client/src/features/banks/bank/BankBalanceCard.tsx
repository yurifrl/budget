/**
 * Balance hero for a BANK account on the bank Overview (twin of
 * CreditBillCard): label + reconcile pill, big balance, and — when the account
 * is linked to a budget account — its 30-day activity sparkline and in/out
 * flows. Unlinked accounts show only label + balance.
 */

import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { Sparkline } from '@/ui/Sparkline';
import { t } from './i18n';

export interface BankBalanceLinked {
  /** From balanceReconcile(). */
  reconcile: { matches: boolean; diffCents: number } | null;
  series: number[];
  inCents: number;
  outCents: number;
}

export function BankBalanceCard({ balanceCents, linked }: { balanceCents: number; linked: BankBalanceLinked | null }) {
  const { formatMoney } = useMoneyFormat();
  const [width, setWidth] = useState(0);
  const rec = linked?.reconcile ?? null;
  return (
    <View style={styles.wrap}>
      <View style={styles.row}>
        <Text style={styles.label}>{t('balance.title')}</Text>
        {rec ? (
          <View style={rec.matches ? styles.okPill : styles.warnPill}>
            <Text style={rec.matches ? styles.okText : styles.warnText}>
              {rec.matches ? t('balance.matches') : t('balance.differs', { amount: formatMoney(rec.diffCents) })}
            </Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.balance, balanceCents < 0 && styles.negative]}>{formatMoney(balanceCents)}</Text>
      {linked ? (
        <>
          <View onLayout={(e) => setWidth(Math.floor(e.nativeEvent.layout.width))} style={styles.spark}>
            {width > 0 ? <Sparkline points={linked.series} width={width} height={40} fill={colors.indigo2} /> : null}
          </View>
          <View style={styles.row}>
            <Text style={styles.flows}>
              <Text style={styles.inflow}>{t('balance.in', { amount: formatMoney(linked.inCents) })}</Text>
              <Text style={styles.muted}>{'  ·  '}</Text>
              <Text style={styles.outflow}>{t('balance.out', { amount: formatMoney(linked.outCents) })}</Text>
            </Text>
            <Text style={styles.muted}>{t('balance.last30')}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  label: { color: colors.muted, fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  okPill: { backgroundColor: colors.greenPillBg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  okText: { color: colors.greenPillFg, fontSize: 12, fontWeight: '700' },
  warnPill: { backgroundColor: colors.yellowPillBg, borderRadius: radius.pill, paddingHorizontal: 10, paddingVertical: 3 },
  warnText: { color: colors.yellowPillFg, fontSize: 12, fontWeight: '700' },
  balance: { color: colors.text, fontSize: 28, fontWeight: '800', fontVariant: ['tabular-nums'] },
  negative: { color: colors.redFg },
  spark: { height: 40, alignSelf: 'stretch' },
  flows: { fontSize: 13, fontVariant: ['tabular-nums'] },
  inflow: { color: colors.greenPillFg, fontWeight: '700' },
  outflow: { color: colors.redFg, fontWeight: '700' },
  muted: { color: colors.muted, fontSize: 13, fontWeight: '400' },
});
