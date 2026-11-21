/**
 * One linked account's tab on the bank page: that account's bank-imported
 * transactions only, newest first. Lazy and paginated — it is mounted only
 * once the tab is opened, fetches page 1 then, and pulls further keyset pages
 * as the list nears its end (plus an explicit "Load more" fallback).
 */

import { useCallback, useMemo } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConnectionTxnJson } from '@/budget/data/connections';
import { useGetConnectionTransactionsInfiniteQuery } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { txnStateView, type TxnStateTone } from '../model/bankPage';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { AmountPill } from '@/ui/AmountPill';
import { ClearedBadge } from '@/ui/ClearedBadge';
import { t } from './i18n';

const TONE_BG: Record<TxnStateTone, string> = {
  neutral: colors.grayPillBg,
  warn: colors.yellowPillBg,
  bad: colors.redPillBg,
};
const TONE_FG: Record<TxnStateTone, string> = {
  neutral: colors.grayPillFg,
  warn: colors.yellowPillFg,
  bad: colors.redFg,
};

export function AccountTab({ connectionId, accountId, wide }: { connectionId: string; accountId: string; wide: boolean }) {
  const query = useGetConnectionTransactionsInfiniteQuery({ id: connectionId, accountId });
  const items = useMemo(() => query.data?.pages.flatMap((p) => p.items) ?? [], [query.data]);
  const { hasNextPage, isFetching, fetchNextPage } = query;
  const loadMore = useCallback(() => {
    if (hasNextPage && !isFetching) void fetchNextPage();
  }, [hasNextPage, isFetching, fetchNextPage]);

  if (query.isLoading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.indigo2} />
      </View>
    );
  }
  if (query.isError) {
    return <Text style={styles.hint}>{t('account.loadFailed')}</Text>;
  }
  if (items.length === 0) {
    return <Text style={styles.hint}>{t('account.empty')}</Text>;
  }

  return (
    <View style={styles.wrap}>
      {wide ? (
        <View style={styles.thead}>
          <Text style={[styles.th, styles.cDate]}>{t('account.col.date')}</Text>
          <Text style={[styles.th, styles.cPayee]}>{t('account.col.payee')}</Text>
          <Text style={[styles.th, styles.cMemo]}>{t('account.col.memo')}</Text>
          <Text style={[styles.th, styles.cState]}>{t('account.col.state')}</Text>
          <Text style={[styles.th, styles.cAmount]}>{t('account.col.amount')}</Text>
          <Text style={[styles.th, styles.cCleared]}>{t('account.col.cleared')}</Text>
        </View>
      ) : null}
      <FlatList
        style={styles.list}
        data={items}
        keyExtractor={(txn) => txn.id}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        renderItem={({ item }) => (wide ? <TxnRow txn={item} /> : <TxnCard txn={item} />)}
        contentContainerStyle={wide ? undefined : styles.cards}
        ListFooterComponent={
          <View style={styles.footer}>
            {isFetching ? (
              <ActivityIndicator color={colors.indigo2} />
            ) : hasNextPage ? (
              <Pressable onPress={loadMore} accessibilityRole="button">
                <Text style={styles.more}>{t('account.loadMore')}</Text>
              </Pressable>
            ) : (
              <Text style={styles.end}>{t('account.end', { count: items.length })}</Text>
            )}
          </View>
        }
      />
    </View>
  );
}

function StatePill({ txn }: { txn: ConnectionTxnJson }) {
  const view = txnStateView(txn.state);
  return (
    <View style={[styles.statePill, { backgroundColor: TONE_BG[view.tone] }]}>
      <Text style={[styles.stateText, { color: TONE_FG[view.tone] }]}>{view.label}</Text>
    </View>
  );
}

function TxnRow({ txn }: { txn: ConnectionTxnJson }) {
  const { formatDate } = useMoneyFormat();
  return (
    <View style={[styles.row, txn.state === 'removed' && styles.removed]}>
      <Text style={[styles.cell, styles.cDate, { color: colors.muted }]}>{formatDate(txn.date)}</Text>
      <Text style={[styles.cell, styles.cPayee]} numberOfLines={1}>
        {txn.payee || t('account.noPayee')}
      </Text>
      <Text style={[styles.cell, styles.cMemo, { color: colors.faint }]} numberOfLines={1}>
        {txn.memo ?? ''}
      </Text>
      <View style={styles.cState}>
        <StatePill txn={txn} />
      </View>
      <View style={[styles.cAmount, styles.amountCell]}>
        <AmountPill cents={milliToCents(txn.amount)} />
      </View>
      <View style={styles.cCleared}>
        <ClearedBadge status={txn.cleared} />
      </View>
    </View>
  );
}

function TxnCard({ txn }: { txn: ConnectionTxnJson }) {
  const { formatDate } = useMoneyFormat();
  return (
    <View style={[styles.card, txn.state === 'removed' && styles.removed]}>
      <View style={styles.cardL1}>
        <Text style={styles.cardPayee} numberOfLines={1}>
          {txn.payee || t('account.noPayee')}
        </Text>
        <AmountPill cents={milliToCents(txn.amount)} />
        <ClearedBadge compact status={txn.cleared} />
      </View>
      <View style={styles.cardL2}>
        <Text style={styles.cardMeta} numberOfLines={1}>
          {[formatDate(txn.date), txn.memo].filter(Boolean).join(' · ')}
        </Text>
        <StatePill txn={txn} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1 },
  list: { flex: 1 },
  center: { paddingVertical: 32, alignItems: 'center' },
  hint: { color: colors.faint, fontSize: 13, paddingVertical: 24, textAlign: 'center' },
  thead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  th: { color: colors.faint, fontSize: 11, letterSpacing: 0.5 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  removed: { opacity: 0.6 },
  cell: { color: colors.text, fontSize: 13 },
  cDate: { width: 110 },
  cPayee: { flex: 1.4, minWidth: 0 },
  cMemo: { flex: 1.2, minWidth: 0 },
  cState: { width: 130 },
  cAmount: { width: 130, textAlign: 'right' },
  amountCell: { alignItems: 'flex-end' },
  cCleared: { width: 30, alignItems: 'center' },
  statePill: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 8, paddingVertical: 2 },
  stateText: { fontSize: 11, fontWeight: '600' },
  cards: { gap: 8, paddingBottom: 24 },
  card: { padding: 10, borderRadius: radius.sm, backgroundColor: colors.card, gap: 6 },
  cardL1: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  cardPayee: { flex: 1, minWidth: 40, color: colors.text, fontSize: 13, fontWeight: '600' },
  cardL2: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardMeta: { flex: 1, color: colors.muted, fontSize: 12 },
  footer: { paddingVertical: 16, alignItems: 'center' },
  more: { color: colors.indigo3, fontSize: 13, fontWeight: '600' },
  end: { color: colors.faint, fontSize: 12 },
});
