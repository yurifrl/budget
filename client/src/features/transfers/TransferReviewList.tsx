/**
 * "Looks like a transfer" review list (mock ②): one row per suggestion with
 * its proposed other side, select some or all, then link or dismiss in bulk.
 * Rows with several possible matches ask to pick (opens the popover); rows
 * with no matching row say so. Works in one account and in All Accounts.
 */
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { TransferSuggestion } from '@/budget/data/api';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { t } from './i18n';
import { MatchPill, TransferCheckbox } from './TransferBits';
import { bulkSummary, reviewRow, type ReviewRow, type TransferLeg } from './transfers.logic';
import type { TransfersState } from './useTransfers';

function Side({ leg }: { leg: TransferLeg }) {
  return (
    <Text style={styles.cell} numberOfLines={1}>
      {t('review.side', { account: leg.account_name, payee: leg.payee_name ?? '' })}
    </Text>
  );
}

function ToCell({ row, onPick }: { row: ReviewRow; onPick: (x: number, y: number) => void }) {
  if (row.to && row.from) return <Side leg={row.to} />;
  if (row.choices.length > 0) {
    return (
      <Text style={styles.cell} numberOfLines={2}>
        <Text style={styles.warn}>{t('review.possible', { count: row.choices.length })}</Text>{' '}
        {row.choices.map((c) => c.account_name).join(' / ')}{' '}
        <Text style={styles.link} onPress={(e) => onPick(e.nativeEvent.pageX, e.nativeEvent.pageY)} accessibilityRole="link">
          {t('review.pick')}
        </Text>
      </Text>
    );
  }
  return (
    <Text style={[styles.cell, styles.muted]} numberOfLines={2}>
      {t('review.noMatch')}
    </Text>
  );
}

export function TransferReviewList({
  suggestions,
  loading,
  isPhone,
  actions,
  onOpenPopover,
}: {
  suggestions: readonly TransferSuggestion[];
  loading: boolean;
  isPhone: boolean;
  actions: Pick<TransfersState, 'linkMany' | 'dismiss'>;
  onOpenPopover: (txnId: string, x: number, y: number) => void;
}) {
  const { formatMoney, formatDate } = useMoneyFormat();
  const rows = useMemo(() => suggestions.map((s) => reviewRow(s)), [suggestions]);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const chosen = rows.filter((r) => selected.has(r.id));
  const summary = bulkSummary(chosen);
  const allOn = rows.length > 0 && chosen.length === rows.length;
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };
  const after = (ok: boolean) => ok && setSelected(new Set());
  // "No matching row" first column on the inflow side: name it in FROM's place.
  const fromCell = (r: ReviewRow) => (r.from ? <Side leg={r.from} /> : r.to ? <Side leg={r.to} /> : null);

  return (
    <View style={styles.wrap}>
      {chosen.length > 0 ? (
        <View style={[styles.bulk, isPhone && styles.bulkPhone]}>
          <Text style={styles.bulkCount}>{t('bulk.selected', { count: summary.count })}</Text>
          <Text style={[styles.muted, { flexShrink: 1 }]} numberOfLines={1}>
            {t('bulk.totals', { out: `– ${formatMoney(summary.out)}`, in: `+ ${formatMoney(summary.in)}` })}
          </Text>
          <View style={{ flex: 1 }} />
          <Pressable style={styles.btn} accessibilityRole="button" onPress={() => void actions.dismiss(summary.dismissIds).then(after)}>
            <Text style={styles.btnText}>{t('bulk.dismiss')}</Text>
          </Pressable>
          <Pressable
            style={[styles.btn, styles.primary, summary.links.length === 0 && styles.disabled]}
            disabled={summary.links.length === 0}
            accessibilityRole="button"
            onPress={() => void actions.linkMany(summary.links).then(after)}>
            <Text style={styles.primaryText}>{t('bulk.link', { count: summary.links.length })}</Text>
          </Pressable>
        </View>
      ) : null}
      {!isPhone ? (
        <View style={styles.head}>
          <TransferCheckbox checked={allOn} onToggle={() => setSelected(allOn ? new Set() : new Set(rows.map((r) => r.id)))} label={t('review.selectAll')} />
          <Text style={[styles.headText, { width: 70 }]}>{t('review.colDate')}</Text>
          <Text style={[styles.headText, { flex: 1 }]}>{t('review.colFrom')}</Text>
          <Text style={[styles.headText, { flex: 1.2 }]}>{t('review.colTo')}</Text>
          <Text style={[styles.headText, { width: 76 }]}>{t('review.colMatch')}</Text>
          <Text style={[styles.headText, { width: 110, textAlign: 'right' }]}>{t('review.colAmount')}</Text>
        </View>
      ) : null}
      <FlatList
        data={rows}
        keyExtractor={(r) => r.id}
        ListEmptyComponent={<Text style={styles.empty}>{loading ? t('review.loading') : t('review.empty')}</Text>}
        renderItem={({ item: r }) => {
          const on = selected.has(r.id);
          const check = <TransferCheckbox checked={on} onToggle={() => toggle(r.id)} label={t('review.select', { payee: r.payee })} />;
          const amount = <Text style={styles.amount}>{formatMoney(r.amount)}</Text>;
          const pick = (x: number, y: number) => onOpenPopover(r.id, x, y);
          if (isPhone) {
            return (
              <View style={[styles.rowPhone, on && styles.rowOn]}>
                {check}
                <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
                  <View style={styles.lineTop}>
                    <Text style={styles.muted}>{formatDate(r.date)}</Text>
                    <MatchPill kind={r.match} />
                    <View style={{ flex: 1 }} />
                    {amount}
                  </View>
                  {fromCell(r)}
                  <View style={styles.lineTop}>
                    <Text style={styles.arrow}>→</Text>
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <ToCell row={r} onPick={pick} />
                    </View>
                  </View>
                </View>
              </View>
            );
          }
          return (
            <View style={[styles.row, on && styles.rowOn]}>
              {check}
              <Text style={[styles.cell, { width: 70 }]}>{formatDate(r.date)}</Text>
              <View style={{ flex: 1, minWidth: 0 }}>{fromCell(r)}</View>
              <View style={{ flex: 1.2, minWidth: 0 }}>
                <ToCell row={r} onPick={pick} />
              </View>
              <View style={{ width: 76 }}>
                <MatchPill kind={r.match} />
              </View>
              <View style={{ width: 110, alignItems: 'flex-end' }}>{amount}</View>
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, minHeight: 0 },
  bulk: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingVertical: 8,
    paddingHorizontal: 14,
    backgroundColor: colors.blueSoft,
    borderWidth: 1,
    borderColor: colors.blueBorder,
    borderRadius: radius.sm,
  },
  bulkPhone: { flexWrap: 'wrap', marginHorizontal: 12 },
  bulkCount: { color: colors.text, fontWeight: '700', fontSize: 13 },
  head: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 6,
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
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowPhone: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  rowOn: { backgroundColor: colors.blueSoft },
  lineTop: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cell: { color: colors.text, fontSize: 13 },
  muted: { color: colors.muted, fontSize: 12 },
  warn: { color: colors.yellowPillFg },
  link: { color: colors.indigo3, fontWeight: '600' },
  arrow: { color: colors.blue, fontWeight: '800' },
  amount: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  empty: { color: colors.muted, fontSize: 13, padding: 20 },
  btn: { borderWidth: 1, borderColor: colors.border, borderRadius: 7, paddingVertical: 5, paddingHorizontal: 9 },
  btnText: { color: colors.text, fontSize: 12, fontWeight: '600' },
  primary: { backgroundColor: colors.indigo, borderColor: colors.indigo },
  primaryText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  disabled: { opacity: 0.4 },
});
