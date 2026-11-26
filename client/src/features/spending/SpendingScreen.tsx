/**
 * Spending — the date-grouped transaction feed (mock's phone "Spending" tab),
 * with the new-transactions review strip and approve actions. The budget-wide
 * person filter narrows the feed to that person's accounts (budgetForPerson).
 */

import { useMemo } from 'react';
import { ActivityIndicator, SectionList, StyleSheet, Text, View, Pressable } from 'react-native';

import { useUpdateTransactionMutation } from '@/budget/data/api';
import { categoryLabel } from '@/domain/bundles';
import { registerCategoryCell } from '@/domain/register';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { budgetForPerson } from '@/domain/people';
import type { Transaction } from '@/domain/types';
import { colors, radius } from '@/ui/theme';
import { useBudgetModel } from '@/state/useBudgetModel';
import { usePersonFilter , PersonFilterBar } from '@/features/people';
import { useBudgetShell } from '@/shell/context';

import { t } from './i18n';

import { displaySystemName } from '@/domain/systemNames';

export function SpendingScreen() {
  const { formatMoney, formatDateLong } = useMoneyFormat();
  const shell = useBudgetShell();
  const { budget, budgetId, error } = useBudgetModel();
  const [updateTransaction] = useUpdateTransactionMutation();

  const byPerson = usePersonFilter(budget, budgetId);
  const scoped = useMemo(() => (budget ? budgetForPerson(budget, byPerson.person) : null), [budget, byPerson.person]);

  const sections = useMemo(() => {
    if (!scoped) return [];
    const byDate = new Map<string, Transaction[]>();
    const sorted = [...scoped.transactions].sort((a, b) => (a.date < b.date ? 1 : -1));
    for (const t of sorted) byDate.set(t.date, [...(byDate.get(t.date) ?? []), t]);
    return [...byDate.entries()].map(([date, data]) => ({ date, data }));
  }, [scoped]);

  if (!budget || !scoped || !budgetId) {
    return (
      <View style={styles.center}>
        {error ? <Text style={{ color: colors.redFg }}>{error}</Text> : <ActivityIndicator color={colors.indigo2} />}
      </View>
    );
  }

  const unapproved = scoped.transactions.filter((t) => !t.approved).length;

  return (
    <View style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}>
      <Text style={styles.title}>{t('screen.title')}</Text>
      <PersonFilterBar
        byPerson={byPerson}
        budgetId={budgetId}
        caption={byPerson.accountsLabel ? t('caption.accounts', { accounts: byPerson.accountsLabel }) : null}
      />
      {unapproved > 0 ? (
        <View style={styles.reviewStrip}>
          <Text style={styles.reviewBadge}>{unapproved}</Text>
          <Text style={styles.reviewText}>{t('review.title')}</Text>
          <Text style={styles.reviewAction}>{t('review.action')}</Text>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {byPerson.accountsLabel ? t('empty.accounts', { accounts: byPerson.accountsLabel }) : t('empty.none')}
          </Text>
        }
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: 15, paddingBottom: 90 }}
        renderSectionHeader={({ section }) => (
          <Text style={styles.dateHeader}>{formatDateLong(section.date)}</Text>
        )}
        renderItem={({ item: txn }) => {
          const categoryNameFor = (id: string) => {
            const c = budget.categories.find((x) => x.id === id);
            return c ? categoryLabel(c, budget.bundles) : '?';
          };
          // The register's rule: a transfer between on-budget accounts needs no category and raises no warning.
          const cell = registerCategoryCell(budget, txn);
          const cat = txn.categoryId && !cell.notNeeded ? categoryNameFor(txn.categoryId) : cell.warn ? t('row.unknown') : cell.text;
          const warn = cell.warn;
          const acct = budget.accounts.find((a) => a.id === txn.accountId);
          return (
            <View style={styles.txn}>
              <View style={styles.l1}>
                <Text style={styles.payee} numberOfLines={1}>
                  {displaySystemName(txn.payee) || t('row.noPayee')}
                </Text>
                <Text style={[styles.amt, txn.inflow > 0 && { color: colors.greenPillFg }]}>
                  {txn.inflow > 0 ? formatMoney(txn.inflow) : `−${formatMoney(txn.outflow)}`}
                  {txn.cleared === 'reconciled' ? ' 🔒' : ''}
                </Text>
              </View>
              <View style={styles.l2}>
                <Text style={[styles.tagPill, warn && styles.tagPillWarn]}>{cat}</Text>
                <Text style={styles.acct}>{acct?.name}</Text>
              </View>
              {!txn.approved ? (
                <Pressable
                  onPress={() =>
                    void updateTransaction({ budgetId, id: txn.id, patch: { approved: true } })
                  }
                  style={styles.approveBtn}>
                  <Text style={styles.approveBtnText}>{t('row.approve')}</Text>
                </Pressable>
              ) : null}
              {txn.memo ? <Text style={styles.memo}>{txn.memo}</Text> : null}
            </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  title: {
    color: colors.text,
    fontSize: 22,
    fontWeight: '800',
    paddingHorizontal: 17,
    paddingVertical: 10,
  },
  empty: { color: colors.faint, fontSize: 13, paddingVertical: 24, textAlign: 'center' },
  reviewStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 15,
    marginBottom: 8,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    padding: 11,
  },
  reviewBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.indigoSoft,
    color: '#bcaff7',
    textAlign: 'center',
    lineHeight: 24,
    fontWeight: '800',
    fontSize: 11,
    overflow: 'hidden',
  },
  reviewText: { color: colors.text, fontSize: 13, flex: 1 },
  reviewAction: { color: colors.indigo2, fontWeight: '700', fontSize: 13 },
  dateHeader: { color: colors.muted, fontSize: 13, fontWeight: '700', marginTop: 15, marginBottom: 5 },
  txn: { paddingVertical: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  l1: { flexDirection: 'row', justifyContent: 'space-between', gap: 10 },
  payee: { color: colors.text, fontWeight: '600', fontSize: 14, flex: 1 },
  amt: { color: colors.text, fontWeight: '600', fontSize: 14, fontVariant: ['tabular-nums'] },
  l2: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 7 },
  tagPill: {
    fontSize: 12,
    paddingVertical: 4,
    paddingHorizontal: 9,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: 'hidden',
  },
  tagPillWarn: { backgroundColor: colors.yellowPillBg, color: colors.yellowPillFg },
  acct: { color: colors.faint, fontSize: 12 },
  memo: { color: colors.faint, fontSize: 11, marginTop: 4 },
  approveBtn: {
    marginTop: 8,
    alignSelf: 'flex-start',
    backgroundColor: colors.indigo,
    borderRadius: radius.pill,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  approveBtnText: { color: colors.white, fontSize: 12, fontWeight: '700' },
});
