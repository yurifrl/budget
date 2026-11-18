/**
 * Spending — the date-grouped transaction feed (mock's phone "Spending" tab),
 * with the new-transactions review strip and approve actions. The budget-wide
 * person filter narrows the feed to that person's accounts (budgetForPerson).
 */

import { useMemo } from 'react';
import { ActivityIndicator, SectionList, StyleSheet, Text, View, Pressable } from 'react-native';

import { useUpdateTransactionMutation } from '../data/api';
import { categoryLabel } from '../domain/bundles';
import { useMoneyFormat } from '../model/useDisplayPrefs';
import { budgetForPerson } from '../domain/people';
import type { Transaction } from '../domain/types';
import { colors, radius } from '../ui/theme';
import { useBudgetModel } from '../model/useBudgetModel';
import { usePersonFilter } from '../model/usePersonFilter';
import { PersonFilterBar } from './PersonFilterBar';
import { useBudgetShell } from './shell';

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
      <Text style={styles.title}>Spending</Text>
      <PersonFilterBar
        byPerson={byPerson}
        budgetId={budgetId}
        caption={byPerson.accountsLabel ? `Spending on ${byPerson.accountsLabel}` : null}
      />
      {unapproved > 0 ? (
        <View style={styles.reviewStrip}>
          <Text style={styles.reviewBadge}>{unapproved}</Text>
          <Text style={styles.reviewText}>New transactions</Text>
          <Text style={styles.reviewAction}>Review below</Text>
        </View>
      ) : null}
      <SectionList
        sections={sections}
        ListEmptyComponent={
          <Text style={styles.empty}>
            {byPerson.accountsLabel ? `No transactions on ${byPerson.accountsLabel}.` : 'No transactions yet.'}
          </Text>
        }
        keyExtractor={(t) => t.id}
        contentContainerStyle={{ paddingHorizontal: 15, paddingBottom: 90 }}
        renderSectionHeader={({ section }) => (
          <Text style={styles.dateHeader}>{formatDateLong(section.date)}</Text>
        )}
        renderItem={({ item: t }) => {
          const categoryNameFor = (id: string) => {
            const c = budget.categories.find((x) => x.id === id);
            return c ? categoryLabel(c, budget.bundles) : '?';
          };
          const cat = t.categoryId
            ? categoryNameFor(t.categoryId)
            : t.inflow > 0 || t.payee === 'Reconciliation Adjustment'
              ? '⚖ Ready to Assign'
              : '🙋 What is this?';
          const warn = !t.categoryId && t.inflow === 0 && t.payee !== 'Reconciliation Adjustment';
          const acct = budget.accounts.find((a) => a.id === t.accountId);
          return (
            <View style={styles.txn}>
              <View style={styles.l1}>
                <Text style={styles.payee} numberOfLines={1}>
                  {t.payee || '(no payee)'}
                </Text>
                <Text style={[styles.amt, t.inflow > 0 && { color: colors.greenPillFg }]}>
                  {t.inflow > 0 ? formatMoney(t.inflow) : `−${formatMoney(t.outflow)}`}
                  {t.cleared === 'reconciled' ? ' 🔒' : ''}
                </Text>
              </View>
              <View style={styles.l2}>
                <Text style={[styles.tagPill, warn && styles.tagPillWarn]}>{cat}</Text>
                <Text style={styles.acct}>{acct?.name}</Text>
              </View>
              {!t.approved ? (
                <Pressable
                  onPress={() =>
                    void updateTransaction({ budgetId, id: t.id, patch: { approved: true } })
                  }
                  style={styles.approveBtn}>
                  <Text style={styles.approveBtnText}>Approve</Text>
                </Pressable>
              ) : null}
              {t.memo ? <Text style={styles.memo}>{t.memo}</Text> : null}
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
  approveBtnText: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
