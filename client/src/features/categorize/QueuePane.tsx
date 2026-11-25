/**
 * The left side of the One by one view: the queue as a compact list (payee,
 * date and best category, amount, best confidence), the row in focus marked.
 * The list scrolls inside its own column; the page itself does not move while
 * rows are filed.
 */

import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { CategorizeQueueRow } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';

import { t } from './i18n';
import { queueRowSubline } from './oneByOne.logic';
import { thresholdPercent } from './page.logic';
import { confidenceBand, type ConfidenceBand } from './queue.logic';

const BAND_COLOR: Record<ConfidenceBand, string> = {
  high: colors.greenPillFg,
  mid: colors.yellowPillFg,
  low: colors.muted,
};

export function QueuePane({
  rows,
  focusedId,
  total,
  hiddenBelow,
  onFocus,
}: {
  rows: readonly CategorizeQueueRow[];
  focusedId: string | null;
  /** Rows the queue holds (all of them, not only this page). */
  total: number;
  /** Rows beyond the loaded page. */
  hiddenBelow: number;
  onFocus: (row: CategorizeQueueRow) => void;
}) {
  const { formatMoney, formatDateShort } = useMoneyFormat();
  return (
    <View style={styles.pane}>
      <View style={styles.head}>
        <Text style={styles.title}>
          {t('one.queueTitle')} <Text style={styles.count}>{t('one.queueLeft', { count: total })}</Text>
        </Text>
        <Text style={styles.order}>{t('one.queueOrder')}</Text>
      </View>
      <ScrollView style={styles.list} nestedScrollEnabled>
        {rows.map((row) => {
          const focused = row.transaction_id === focusedId;
          const payee = row.payee?.trim() || row.raw_bank_description?.trim() || t('row.unnamed');
          const cents = milliToCents(row.amount);
          const top = row.suggestions[0];
          return (
            <Pressable
              key={row.transaction_id}
              onPress={() => onFocus(row)}
              accessibilityRole="button"
              accessibilityState={{ selected: focused }}
              accessibilityLabel={t('one.rowA11y', { payee, amount: formatMoney(cents) })}
              style={[styles.row, focused && styles.rowFocused]}>
              <View style={styles.rowText}>
                <Text style={styles.payee} numberOfLines={1}>
                  {payee}
                </Text>
                <Text style={styles.sub} numberOfLines={1}>
                  {queueRowSubline(row, formatDateShort(row.date))}
                </Text>
              </View>
              <View style={styles.rowEnd}>
                <Text style={[styles.amount, cents > 0 && styles.in]}>{formatMoney(cents)}</Text>
                {top ? (
                  <Text style={[styles.percent, { color: BAND_COLOR[confidenceBand(top.confidence)] }]}>
                    {thresholdPercent(top.confidence)}%
                  </Text>
                ) : null}
              </View>
            </Pressable>
          );
        })}
        {hiddenBelow > 0 ? <Text style={styles.more}>{t('one.moreBelow', { count: hiddenBelow })}</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  pane: {
    width: '100%',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 9,
    overflow: 'hidden',
  },
  head: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 14,
  },
  title: { color: colors.text, fontSize: 13, fontWeight: '700' },
  count: { color: colors.muted, fontWeight: '500' },
  order: { color: colors.muted, fontSize: 11.5 },
  list: { maxHeight: 640 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    borderLeftWidth: 3,
    borderLeftColor: 'transparent',
  },
  rowFocused: { backgroundColor: colors.indigoSoft, borderLeftColor: colors.indigo2 },
  rowText: { flex: 1, minWidth: 0, gap: 1 },
  payee: { color: colors.text, fontSize: 13.5, fontWeight: '600' },
  sub: { color: colors.faint, fontSize: 11.5 },
  rowEnd: { alignItems: 'flex-end', gap: 1 },
  amount: { color: colors.text, fontSize: 13, fontWeight: '700' },
  in: { color: colors.greenPillFg },
  percent: { fontSize: 12, fontWeight: '700' },
  more: { color: colors.faint, fontSize: 12, textAlign: 'center', padding: 14 },
});
