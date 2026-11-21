/**
 * Budget Home — the phone landing tab (mock's "Casa" screen): to-dos (new
 * transactions to review, Ready-to-Assign), and the current goal snapshot.
 */

import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useEffect, useState } from 'react';

import { targetFundingState } from '@/domain/engine';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { IndigoButton } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { useBudgetModel } from '@/state/useBudgetModel';
import { useBudgetMonth } from '@/state/useBudgetMonth';
import { ManagePayeesModal } from '@/features/payees';
import { useBudgetShell } from '@/shell/context';
import { t } from './mobile/i18n';

export function BudgetHomeScreen() {
  const { formatMoney } = useMoneyFormat();
  const router = useRouter();
  const shell = useBudgetShell();
  const { budget, error } = useBudgetModel();
  const bm = useBudgetMonth(budget, budget?.currentMonth ?? 0);
  // ?managePayees=1 — deep link from the register payee dropdown's
  // "Manage Payees…" row; opens the modal mount on arrival.
  const { managePayees: managePayeesParam } = useLocalSearchParams<{ managePayees?: string }>();
  const [payeesOpen, setPayeesOpen] = useState(false);
  useEffect(() => {
    if (managePayeesParam === '1') setPayeesOpen(true);
  }, [managePayeesParam]);

  if (!budget) {
    return (
      <View style={styles.center}>
        {error ? <Text style={{ color: colors.redFg }}>{error}</Text> : <ActivityIndicator color={colors.indigo2} />}
      </View>
    );
  }

  const rta = bm.readyToAssign;
  const newTxns = budget.transactions.filter((txn) => !txn.approved).length;
  const underfunded = budget.categories
    .map((c) => ({ c, f: targetFundingState(c, bm) }))
    // Current Goal lists target shortfalls; a card's underfunded payment has no target.
    .filter((x) => x.f.state === 'yellow' && x.f.underfunded === undefined);

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[
        { paddingBottom: 90 },
        !shell.isDesktop && { paddingTop: shell.contentTopPad },
      ]}>
      <View style={styles.hero}>
        <Text style={styles.heroTitle}>{budget.name}</Text>
      </View>
      <View style={styles.todoCard}>
        <Text style={styles.todoTitle}>{t('home.welcome')}</Text>
        <Text style={styles.todoSub}>{t('home.subtitle')}</Text>
        {newTxns > 0 ? (
          <View style={styles.todoLine}>
            <Text style={styles.badge}>{newTxns}</Text>
            <Text style={styles.todoLineText}>{t('home.newTransactions')}</Text>
            <IndigoButton label={t('home.review')} onPress={() => router.navigate('/spending' as never)} />
          </View>
        ) : null}
        <View style={styles.todoLine}>
          <Text style={[styles.pillGreen]}>{formatMoney(rta)}</Text>
          <Text style={[styles.todoLineText, { color: colors.muted }]}>{t('home.readyToAssign')}</Text>
          <IndigoButton label={t('home.assign')} onPress={() => router.navigate('/plan' as never)} />
        </View>
      </View>
      <View style={styles.card}>
        <Text style={styles.cardTitle}>{t('home.currentGoal')}</Text>
        {underfunded.length ? (
          underfunded.slice(0, 3).map(({ c, f }) => (
            <Text key={c.id} style={styles.cardBody}>
              {c.target?.kind === 'custom' && c.target.config.byDate
                ? t('home.stillNeededByDay', {
                    name: c.name,
                    amount: formatMoney(f.gap),
                    day: c.target.config.byDate.slice(8),
                  })
                : t('home.stillNeeded', { name: c.name, amount: formatMoney(f.gap) })}
            </Text>
          ))
        ) : (
          <Text style={styles.cardBody}>{t('home.allFunded', { name: budget.name })}</Text>
        )}
      </View>
      {!shell.isPhone ? (
        <View style={styles.card}>
          <Text style={styles.cardBody}>
            {t('home.hint')}
          </Text>
          <IndigoButton label={t('home.managePayees')} onPress={() => setPayeesOpen(true)} />
        </View>
      ) : null}
      {payeesOpen ? <ManagePayeesModal visible={payeesOpen} onClose={() => setPayeesOpen(false)} /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  hero: {
    paddingTop: 56,
    paddingBottom: 40,
    paddingHorizontal: 17,
    backgroundColor: '#22506b',
  },
  heroTitle: { color: colors.text, fontSize: 32, fontWeight: '800' },
  todoCard: {
    marginHorizontal: 15,
    marginTop: -24,
    backgroundColor: 'rgba(8,10,16,.9)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,.08)',
    borderRadius: radius.r,
    padding: 15,
  },
  todoTitle: { color: colors.text, fontWeight: '700', fontSize: 15 },
  todoSub: { color: colors.muted, fontSize: 13 },
  todoLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 11,
    backgroundColor: colors.card2,
    borderRadius: radius.sm,
    padding: 10,
    marginTop: 11,
  },
  todoLineText: { color: colors.text, fontSize: 14, flex: 1 },
  badge: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: colors.indigoSoft,
    color: '#bcaff7',
    textAlign: 'center',
    lineHeight: 28,
    fontWeight: '800',
    fontSize: 12,
    overflow: 'hidden',
  },
  pillGreen: {
    backgroundColor: colors.greenPillBg,
    color: colors.greenPillFg,
    paddingVertical: 5,
    paddingHorizontal: 11,
    borderRadius: radius.pill,
    fontWeight: '700',
    fontSize: 13,
    overflow: 'hidden',
  },
  card: {
    marginHorizontal: 15,
    marginTop: 11,
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.r,
    padding: 15,
  },
  cardTitle: { color: colors.text, fontWeight: '700', fontSize: 14, marginBottom: 8 },
  cardBody: { color: colors.muted, fontSize: 13, lineHeight: 19 },
});

