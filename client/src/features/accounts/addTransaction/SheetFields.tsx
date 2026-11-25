import { Pressable, Text, View } from 'react-native';

import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors } from '@/ui/theme';
import { t } from './i18n';
import { styles } from './styles';
import type { AddTransaction } from './useAddTransaction';
import { displaySystemName } from '@/domain/systemNames';

/** The sheet's field rows (inside the sheet's scroll view): payee, category and account open a picker; the date steps by a day. */
export function SheetFields({ sheet }: { sheet: AddTransaction }) {
  const { formatDate } = useMoneyFormat();
  const { payee, category, categoryLocked, labelOf, isIncome, account, date, stepDate, setPicker } = sheet;
  return (
    <>
      <Pressable style={styles.row} onPress={() => setPicker('payee')}>
        <Text style={styles.rowIcon}>◎</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowK}>{t('field.payee')}</Text>
          <Text style={styles.rowV}>{displaySystemName(payee) || t('field.choose')}</Text>
        </View>
        <Text style={styles.chev}>›</Text>
      </Pressable>
      {categoryLocked ? (
        // A transfer between on-budget accounts: no category, and none can be set.
        <View style={[styles.row, styles.rowLocked]} accessibilityLabel={t('field.categoryNotNeeded')}>
          <Text style={styles.rowIcon}>▤</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowK}>{t('field.category')}</Text>
            <Text style={[styles.rowV, { color: colors.faint }]}>{t('field.categoryNotNeeded')}</Text>
          </View>
        </View>
      ) : (
        <Pressable style={styles.row} onPress={() => setPicker('category')}>
          <Text style={styles.rowIcon}>▤</Text>
          <View style={{ flex: 1 }}>
            <Text style={styles.rowK}>{t('field.category')}</Text>
            <Text style={styles.rowV}>
              {(category ? labelOf(category) : null) ?? (isIncome ? t('field.readyToAssign') : t('field.choose'))}
            </Text>
          </View>
          <Text style={styles.chev}>›</Text>
        </Pressable>
      )}
      <Pressable style={styles.row} onPress={() => setPicker('account')}>
        <Text style={[styles.rowIcon, { color: colors.greenPillFg }]}>◉</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowK}>{t('field.account')}</Text>
          <Text style={styles.rowV}>{account?.name ?? t('field.choose')}</Text>
        </View>
        <Text style={styles.chev}>›</Text>
      </Pressable>
      <View style={styles.row}>
        <Text style={styles.rowIcon}>▦</Text>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowK}>{t('field.date')}</Text>
          <Text style={styles.rowV}>{formatDate(date)}</Text>
        </View>
        <Pressable onPress={() => stepDate(-1)} hitSlop={8}>
          <Text style={styles.dateStep}>‹</Text>
        </Pressable>
        <Pressable onPress={() => stepDate(1)} hitSlop={8}>
          <Text style={styles.dateStep}>›</Text>
        </Pressable>
      </View>
    </>
  );
}
