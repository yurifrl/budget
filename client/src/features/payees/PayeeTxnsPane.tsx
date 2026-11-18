import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useGetPayeeTransactionsQuery } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { pageCount } from './payees.logic';
import { styles } from './styles';

/** In-page, paginated table of one payee's transactions (syscd-app-kr7). */
export function PayeeTxnsPane({ budgetId, payeeId }: { budgetId: string; payeeId: string }) {
  const { formatDate, formatMoney } = useMoneyFormat();
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const query = useGetPayeeTransactionsQuery({ budgetId, payeeId, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  if (query.isLoading) return <Text style={styles.txnsEmpty}>Loading…</Text>;
  if (query.error) return <Text style={styles.txnsEmpty}>Failed to load transactions.</Text>;

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = pageCount(total, PAGE_SIZE);

  return (
    <View style={styles.txnsPane}>
      {rows.length === 0 ? (
        <Text style={styles.txnsEmpty}>No transactions.</Text>
      ) : (
        <View style={styles.txnsTable}>
          <View style={[styles.txnsRow, styles.txnsHead]}>
            <Text style={[styles.txnsCell, styles.txnsDate]}>DATE</Text>
            <Text style={[styles.txnsCell, styles.txnsPayee]}>MEMO</Text>
            <Text style={[styles.txnsCell, styles.txnsAccount]}>ACCOUNT</Text>
            <Text style={[styles.txnsCell, styles.txnsCat]}>CATEGORY</Text>
            <Text style={[styles.txnsCellRight, styles.txnsAmount]}>AMOUNT</Text>
          </View>
          {rows.map((t) => (
            <Pressable key={t.id} style={styles.txnsRow}>
              <Text style={[styles.txnsCell, styles.txnsDate]}>{formatDate(t.date)}</Text>
              <Text style={[styles.txnsCell, styles.txnsPayee]} numberOfLines={1}>
                {t.memo || '—'}
              </Text>
              <Text style={[styles.txnsCell, styles.txnsAccount]} numberOfLines={1}>
                {t.account_name}
              </Text>
              <Text style={[styles.txnsCell, styles.txnsCat]} numberOfLines={1}>
                {t.category_name ?? '—'}
              </Text>
              <Text
                style={[
                  styles.txnsCellRight,
                  styles.txnsAmount,
                  t.amount < 0 && styles.txnsAmountNeg,
                ]}>
                {formatMoney(milliToCents(t.amount))}
              </Text>
            </Pressable>
          ))}
        </View>
      )}
      <View style={styles.txnsPager}>
        <Pressable onPress={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0}>
          <Text style={[styles.txnsPageBtn, page === 0 && styles.txnsPageBtnOff]}>← Prev</Text>
        </Pressable>
        <Text style={styles.txnsPageInfo}>
          Page {page + 1} of {pages}
        </Text>
        <Pressable
          onPress={() => setPage((p) => (p + 1 < pages ? p + 1 : p))}
          disabled={page + 1 >= pages}>
          <Text style={[styles.txnsPageBtn, page + 1 >= pages && styles.txnsPageBtnOff]}>Next →</Text>
        </Pressable>
      </View>
    </View>
  );
}
