/**
 * One self-contained card describing a link candidate (an upstream bank
 * account or a budget account): name, bank, type badge, prominent balance, a
 * credit card's bill/limit lines, the match hint and any warning. Shared by
 * the picker rows and the "currently linked" card, so both read the same.
 */

import { StyleSheet, Text, View } from 'react-native';

import type { LinkOption } from '../model/linkPicker';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';

export function LinkOptionCard({ option, dim }: { option: LinkOption; dim?: boolean }) {
  const { formatMoney } = useMoneyFormat();
  const { credit, hint } = option;
  return (
    <View style={styles.body}>
      <View style={styles.head}>
        <View style={styles.titleCol}>
          <Text style={[styles.title, dim && styles.dim]} numberOfLines={2}>{option.title}</Text>
          {option.institution ? <Text style={styles.institution} numberOfLines={1}>{option.institution}</Text> : null}
        </View>
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{option.badge}</Text>
        </View>
      </View>

      {option.balanceCents != null ? (
        <Text style={[styles.balance, dim && styles.dim, option.balanceCents < 0 && !dim && styles.negative]}>
          {formatMoney(option.balanceCents)}
        </Text>
      ) : null}

      {credit ? (
        <View style={styles.lines}>
          {credit.billCents != null ? <Line label={t('card.currentBill')} value={formatMoney(credit.billCents)} /> : null}
          {credit.due ? <Line label={t('card.dueDate')} value={credit.due} /> : null}
          {credit.usedCents != null ? <Line label={t('card.limitUsed')} value={formatMoney(credit.usedCents)} /> : null}
          {credit.limitCents != null ? <Line label={t('card.limit')} value={formatMoney(credit.limitCents)} /> : null}
        </View>
      ) : null}

      {option.linkedTo ? (
        <Text style={styles.linkedTo}>{t('card.linkedTo', { name: option.linkedTo })}</Text>
      ) : hint ? (
        <View style={[styles.hint, hint.kind === 'match' ? styles.hintOk : styles.hintDiff]}>
          <Text style={hint.kind === 'match' ? styles.hintOkText : styles.hintDiffText}>
            {hint.kind === 'match' ? t('card.matches') : t('card.different', { amount: formatMoney(hint.diffCents) })}
          </Text>
        </View>
      ) : null}
      {option.warning && !option.linkedTo ? <Text style={styles.warning}>{`⚠ ${option.warning}`}</Text> : null}
    </View>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.line}>
      <Text style={styles.lineLabel}>{label}</Text>
      <Text style={styles.lineValue}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1, minWidth: 0, gap: 6 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  titleCol: { flex: 1, minWidth: 0, gap: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  institution: { color: colors.faint, fontSize: 11, fontWeight: '600', letterSpacing: 0.4, textTransform: 'uppercase' },
  dim: { color: colors.muted },
  badge: { backgroundColor: colors.grayPillBg, borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  badgeText: { color: colors.grayPillFg, fontSize: 10, fontWeight: '700' },
  balance: { color: colors.text, fontSize: 20, fontWeight: '800', fontVariant: ['tabular-nums'] },
  negative: { color: colors.redFg },
  lines: { gap: 2 },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  lineLabel: { color: colors.muted, fontSize: 12 },
  lineValue: { color: colors.text, fontSize: 12, fontWeight: '600', fontVariant: ['tabular-nums'] },
  hint: { alignSelf: 'flex-start', borderRadius: radius.pill, paddingHorizontal: 8, paddingVertical: 2 },
  hintOk: { backgroundColor: colors.greenPillBg },
  hintDiff: { backgroundColor: colors.yellowPillBg },
  hintOkText: { color: colors.greenPillFg, fontSize: 11, fontWeight: '700' },
  hintDiffText: { color: colors.yellowPillFg, fontSize: 11, fontWeight: '700' },
  linkedTo: { color: colors.muted, fontSize: 12, fontWeight: '600' },
  warning: { color: colors.yellowPillFg, fontSize: 11, lineHeight: 15 },
});
