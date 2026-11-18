/**
 * Linked-account detail (syscd-app-e2t item 2 / slice tk-avhd) — the read-only
 * twin of AccountsScreen's account detail for a bank-linked account: the same
 * register table (desktop) / txn card (phone) rendered from the budget's
 * transaction feed scoped to that account, with provenance (institution ·
 * connection status) in the header and ClearedBadge state per row. No editing
 * affordances: rows don't open editors, no selection, no row menu — bank-synced
 * data is edited through the normal account register instead.
 */

import { useMemo } from 'react';
import { skipToken } from '@reduxjs/toolkit/query';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { useAppSelector } from '@/state/hooks';

import { useGetAccountsQuery, useGetConnectionsQuery } from '@/budget/data/api';
import { connectionStatusView } from './model/connections';
import { computeRunningBalances, workingBalance } from '@/domain/engine';
import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Budget, Transaction } from '@/domain/types';
import { registerCategoryCell } from '@/domain/register';
import { useBudgetModel } from '@/state/useBudgetModel';
import { selectActiveBudgetId } from '@/state/ui';
import { LinkedBy } from './LinkedBy';
import { colors, radius } from '@/ui/theme';
import { BalanceFormulaRow } from '@/ui/BalanceFormulaRow';
import { AmountPill } from '@/ui/AmountPill';
import { ClearedBadge } from '@/ui/ClearedBadge';
import { useBudgetShell } from '@/shell/context';

/** Header subtitle labels, mirroring AccountsScreen's map. */
const ACCOUNT_TYPE_LABEL: Record<Budget['accounts'][number]['type'], string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  credit: 'Credit Card',
  tracking: 'Tracking Account',
};

/** Stable empty array so memos stay referentially equal while loading. */
const EMPTY_TXNS: Transaction[] = [];
const EMPTY_RUNNING = new Map<string, number>();

export function LinkedAccountDetailScreen() {
  const { formatDate, formatMoney } = useMoneyFormat();
  const shell = useBudgetShell();
  const router = useRouter();
  // The linked budget account this register belongs to.
  const { account: accountParam } = useLocalSearchParams<{ account?: string }>();
  const accountId = accountParam ?? null;
  const budgetId = useAppSelector(
    (s) => selectActiveBudgetId(s),
  );
  const { budget, isLoading: budgetLoading, error: budgetError } = useBudgetModel();

  // Direct row queries for the link facts (connection_id / institution are
  // account-row and connection-level, not part of the domain `Account`).
  const accountsQuery = useGetAccountsQuery(budgetId ? { budgetId } : skipToken);
  const connectionsQuery = useGetConnectionsQuery();

  const accountRow = useMemo(
    () => (accountsQuery.data ?? []).find((a) => a.id === accountId) ?? null,
    [accountsQuery.data, accountId],
  );
  const connection = useMemo(
    () =>
      (connectionsQuery.data ?? []).find(
        (c) => accountRow != null && c.id === accountRow.connection_id,
      ) ?? null,
    [connectionsQuery.data, accountRow],
  );

  // Hooks must precede the loading guard below (rules of hooks).
  const txns = useMemo(() => {
    if (!budget || !accountId) return EMPTY_TXNS;
    return budget.transactions.filter((t) => t.accountId === accountId);
  }, [budget, accountId]);

  const runningBalances = useMemo(() => {
    const vmAccount = budget?.accounts.find((a) => a.id === accountId);
    if (!vmAccount) return EMPTY_RUNNING;
    return computeRunningBalances(txns, workingBalance(vmAccount));
  }, [budget, accountId, txns]);

  if (!accountId || !budgetId) {
    return (
      <Centered>
        <Text style={styles.hintText}>No account selected.</Text>
      </Centered>
    );
  }
  if (budgetLoading || accountsQuery.isLoading) {
    return (
      <Centered>
        <ActivityIndicator color={colors.indigo2} />
      </Centered>
    );
  }
  if (budgetError) {
    return (
      <Centered>
        <Text style={styles.hintText}>{budgetError}</Text>
      </Centered>
    );
  }
  if (!accountRow || !budget) {
    return (
      <Centered>
        <Text style={styles.hintText}>Account not found in this budget.</Text>
      </Centered>
    );
  }
  const vmAccount = budget.accounts.find((a) => a.id === accountId);
  const cleared = vmAccount?.clearedBalance ?? 0;
  const uncleared = vmAccount?.unclearedBalance ?? 0;
  const status = connection ? connectionStatusView(connection.status) : null;
  const showWide = !shell.isPhone;

  return (
    <View
      style={[styles.screen, !shell.isDesktop && { paddingTop: shell.contentTopPad }]}
    >
      <View style={[styles.body, shell.isPhone && styles.bodyPhone]}>
        {/* Header: back · name · provenance (institution · link status) +
            an explicit read-only mark where the editing toolbar would sit. */}
        <View style={styles.head}>
          <Pressable onPress={() => router.back()} hitSlop={8} accessibilityLabel="Back">
            <Ionicons name="chevron-back" size={20} color={colors.muted} />
          </Pressable>
          <View style={styles.headMain}>
            <Text
              style={[styles.title, shell.isPhone && styles.titlePhone]}
              numberOfLines={1}
            >
              {accountRow.name}
            </Text>
            <Text style={styles.subtitle} numberOfLines={1}>
              {[
                ACCOUNT_TYPE_LABEL[vmAccount?.type ?? 'checking'],
                accountRow.institution,
                status?.label,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
            <LinkedBy linkedBy={accountRow.linked_by ?? connection?.linked_by} />
          </View>
          <View style={styles.roMark}>
            <Ionicons name="lock-closed" size={12} color={colors.faint} />
            <Text style={styles.roText}>Read-only</Text>
          </View>
        </View>
        <BalanceFormulaRow
          cleared={cleared}
          uncleared={uncleared}
          working={cleared + uncleared}
          compact={shell.isPhone}
        />

        {txns.length === 0 ? (
          <View style={styles.empty}>
            <Text style={styles.hintText}>
              No transactions yet — sync this connection to pull bank rows.
            </Text>
          </View>
        ) : null}

        {/* register header — the Accounts table minus the select column */}
        {txns.length > 0 && showWide ? (
          <View style={styles.reghd}>
            <Text style={[styles.reghdText, { flex: 1.1 }]}>ACCOUNT</Text>
            <Text style={[styles.reghdText, { flex: 0.7 }]}>DATE</Text>
            <Text style={[styles.reghdText, { flex: 1.4 }]}>PAYEE</Text>
            <Text style={[styles.reghdText, { flex: 1.4 }]}>CATEGORY</Text>
            <Text style={[styles.reghdText, { flex: 1.2 }]}>MEMO</Text>
            <Text style={[styles.reghdText, { flex: 1.1, textAlign: 'right' }]}>AMOUNT</Text>
            <Text style={[styles.reghdText, { flex: 1, textAlign: 'right' }]}>RUN. BAL</Text>
            <Text style={[styles.reghdText, styles.slotW]}>C</Text>
          </View>
        ) : null}

        <FlatList
          data={txns}
          keyExtractor={(t) => t.id}
          renderItem={({ item: t }) => {
            const cat = registerCategoryCell(budget, t, { transfers: false });
            if (!showWide) {
              // Phone card — AccountsScreen's txnCard layout without the
              // Pressable/editor: payee + Repeat + amount + cleared mark,
              // category pill beneath.
              return (
                <View style={styles.txnCard}>
                  <View style={styles.txnL1Phone}>
                    <View style={styles.txnLeadPhone}>
                      <Text style={styles.txnPayee} numberOfLines={1}>
                        {t.payee || '(no payee)'}
                      </Text>
                      {t.upcoming ? (
                        <Text style={styles.upcomingPill}>Repeat</Text>
                      ) : null}
                    </View>
                    <AmountPill cents={t.outflow > 0 ? -t.outflow : t.inflow} />
                    {/* Read-only: no approve/toggle handlers — static mark. */}
                    <ClearedBadge compact status={t.cleared} />
                  </View>
                  <View style={styles.txnL2Phone}>
                    <Text
                      style={[styles.tagPill, cat.warn && styles.tagPillWarn]}
                      numberOfLines={1}
                    >
                      {cat.text}
                    </Text>
                  </View>
                </View>
              );
            }
            return (
              <View style={styles.regrow}>
                <Text style={[styles.regText, { flex: 1.1 }]} numberOfLines={1}>
                  {accountRow.name}
                </Text>
                <Text style={[styles.regText, { flex: 0.7, color: colors.muted }]}>
                  {formatDate(t.date)}
                </Text>
                <Text style={[styles.regText, { flex: 1.4 }]} numberOfLines={1}>
                  {t.payee || '(no payee)'}
                </Text>
                <Text
                  style={[styles.tagPill, cat.warn && styles.tagPillWarn]}
                  numberOfLines={1}
                >
                  {cat.text}
                </Text>
                <Text
                  style={[styles.regText, { flex: 1.2, color: colors.faint }]}
                  numberOfLines={1}
                >
                  {t.memo}
                </Text>
                <View style={{ flex: 1.1, flexDirection: 'row', justifyContent: 'flex-end' }}>
                  <AmountPill cents={t.outflow > 0 ? -t.outflow : t.inflow} />
                </View>
                <Text style={[styles.regText, styles.runBal]}>
                  {runningBalances.has(t.id)
                    ? formatMoney(runningBalances.get(t.id)!)
                    : ''}
                </Text>
                {/* Read-only provenance: imported/cleared state, no actions. */}
                <View style={styles.slotW}>
                  <ClearedBadge status={t.cleared} />
                </View>
              </View>
            );
          }}
        />
      </View>
    </View>
  );
}

/** Centered loading / empty-state wrapper. */
function Centered({ children }: { children: React.ReactNode }) {
  return (
    <View style={[styles.screen, styles.centered]}>
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  body: { flex: 1, paddingHorizontal: 16, gap: 10 },
  bodyPhone: { paddingHorizontal: 12 },
  centered: { alignItems: 'center', justifyContent: 'center' },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headMain: { flex: 1, minWidth: 0 },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  titlePhone: { fontSize: 17 },
  subtitle: { color: colors.faint, fontSize: 12, marginTop: 2 },
  roMark: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 999,
    backgroundColor: colors.grayPillBg,
  },
  roText: { color: colors.grayPillFg, fontSize: 11, fontWeight: '600' },
  empty: { alignItems: 'center', paddingVertical: 24 },
  hintText: { color: colors.faint, fontSize: 13 },
  reghd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 4,
    paddingVertical: 5,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
  },
  reghdText: { color: colors.faint, fontSize: 11, letterSpacing: 0.5 },
  regrow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 7,
    paddingHorizontal: 4,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  regText: { color: colors.text, fontSize: 13 },
  txnCard: {
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: radius.sm,
    backgroundColor: colors.card,
    gap: 4,
  },
  txnL1Phone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  txnLeadPhone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  txnPayee: {
    color: colors.text,
    fontWeight: '600',
    fontSize: 13,
    flexShrink: 1,
    minWidth: 40,
  },
  txnL2Phone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  upcomingPill: {
    fontSize: 10,
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: 'hidden',
  },
  tagPill: {
    fontSize: 11,
    paddingVertical: 2,
    paddingHorizontal: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.grayPillBg,
    color: colors.muted,
    overflow: 'hidden',
  },
  tagPillWarn: {
    backgroundColor: colors.yellowPillBg,
    color: colors.yellowPillFg,
  },
  runBal: {
    flex: 1,
    color: colors.muted,
    fontVariant: ['tabular-nums'],
    textAlign: 'right',
  },
  slotW: { width: 30, flexShrink: 0, alignItems: 'center' },
});
