import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { useGetPayeeTransactionsQuery } from '@/budget/data/api';
import { milliToCents } from '@/budget/data/mapping';
import { tCommon } from '@shared/i18n/common';

import { useMoneyFormat } from '@/ui/moneyFormat';
import { t } from './i18n';
import { pageCount } from './payees.logic';
import { styles } from './styles';

/** In-page, paginated table of one payee's transactions (syscd-app-kr7). */
export function PayeeTxnsPane({ budgetId, payeeId }: { budgetId: string; payeeId: string }) {
  const { formatDate, formatMoney } = useMoneyFormat();
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(0);
  const query = useGetPayeeTransactionsQuery({ budgetId, payeeId, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  if (query.isLoading) return <Text style={styles.txnsEmpty}>{tCommon('loading')}</Text>;
  if (query.error) return <Text style={styles.txnsEmpty}>{t('txns.error')}</Text>;

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const pages = pageCount(total, PAGE_SIZE);

  return (
    <View style={styles.txnsPane}>
      {rows.length === 0 ? (
        <Text style={styles.txnsEmpty}>{t('txns.empty')}</Text>
      ) : (
        <View style={styles.txnsTable}>
          <View style={[styles.txnsRow, styles.txnsHead]}>
            <Text style={[styles.txnsCell, styles.txnsDate]}>{t('txns.col.date')}</Text>
            <Text style={[styles.txnsCell, styles.txnsPayee]}>{t('txns.col.memo')}</Text>
            <Text style={[styles.txnsCell, styles.txnsAccount]}>{t('txns.col.account')}</Text>
            <Text style={[styles.txnsCell, styles.txnsCat]}>{t('txns.col.category')}</Text>
            <Text style={[styles.txnsCellRight, styles.txnsAmount]}>{t('txns.col.amount')}</Text>
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
          <Text style={[styles.txnsPageBtn, page === 0 && styles.txnsPageBtnOff]}>{t('txns.prev')}</Text>
        </Pressable>
        <Text style={styles.txnsPageInfo}>
          {t('txns.page', { page: page + 1, pages })}
        </Text>
        <Pressable
          onPress={() => setPage((p) => (p + 1 < pages ? p + 1 : p))}
          disabled={page + 1 >= pages}>
          <Text style={[styles.txnsPageBtn, page + 1 >= pages && styles.txnsPageBtnOff]}>{t('txns.next')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
