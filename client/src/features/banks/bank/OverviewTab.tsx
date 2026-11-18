/**
 * Bank page Overview: connection totals plus one summary card per linked
 * account (bank-side account -> budget account, bank balance, import counts,
 * date range). Pressing a card opens that account's tab. Upstream accounts the
 * user has not linked are listed as such.
 */

import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ConnectionAccountSummaryJson, ConnectionCountsJson, ConnectionSummaryJson, ConnectionUpstreamJson, UpstreamAccountJson } from '@/budget/data/connections';
import type { AccountRow, TransactionRow } from '@/budget/data/rows';
import { accountActivity, balanceReconcile } from '../model/connectionSpark';
import { creditView } from '../model/connections';
import { linkedSummaryAccounts } from '../model/linkPicker';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { colors, radius } from '@/ui/theme';
import { BankBalanceCard } from './BankBalanceCard';
import { CreditBillCard } from './CreditBillCard';
import { LinkAccountSheet, UnlinkAccountSheet } from './LinkSheets';

export function OverviewTab({
  budgetId,
  connectionId,
  institution,
  allUpstream,
  summary,
  upstream,
  accounts,
  transactions,
  onOpenAccount,
}: {
  budgetId: string;
  connectionId: string;
  institution: string | null;
  /** Every connection's upstream accounts (names of what budget accounts follow elsewhere). */
  allUpstream: ConnectionUpstreamJson[];
  summary: ConnectionSummaryJson;
  /** Bank-side accounts; null when the provider call failed. */
  upstream: UpstreamAccountJson[] | null;
  /** Active budget's accounts/transactions (linked-account balance + activity). */
  accounts: AccountRow[];
  transactions: TransactionRow[];
  onOpenAccount: (accountId: string) => void;
}) {
  const linkedAccounts = linkedSummaryAccounts(summary.accounts, upstream, accounts, budgetId);
  const unlinked = (upstream ?? []).filter((a) => a.linkedAccountId == null);
  // Link editing: the bank account being (re)linked and the account being unlinked.
  const [linking, setLinking] = useState<{ bank: UpstreamAccountJson; current: { accountId: string; budgetId: string } | null } | null>(null);
  const bankFor = (acct: ConnectionAccountSummaryJson) => upstream?.find((u) => u.externalId === acct.externalAccountId) ?? null;
  const [unlinking, setUnlinking] = useState<{ id: string; name: string; budgetId: string } | null>(null);
  return (
    <View style={styles.wrap}>
      <View style={styles.totals}>
        <Stat label="Linked accounts" value={linkedAccounts.length} />
        <Stat label="Imported" value={summary.totals.importedCount} />
        <Stat label="Edited by you" value={summary.totals.editedCount} tone="warn" />
        <Stat label="Removed at bank" value={summary.totals.removedCount} tone="bad" />
        <Stat label="Total rows" value={summary.totals.totalCount} />
      </View>

      <Text style={styles.sectionTitle}>Accounts</Text>
      {linkedAccounts.length === 0 ? (
        <Text style={styles.hint}>No budget account is linked to this bank yet. Use “Link to a budget account” on a bank account below.</Text>
      ) : (
        <View style={styles.grid}>
          {linkedAccounts.map((acct) => (
            <AccountCard
              key={acct.accountId}
              acct={acct}
              bank={upstream?.find((u) => u.externalId === acct.externalAccountId) ?? null}
              budgetAccount={accounts.find((a) => a.id === acct.accountId) ?? null}
              transactions={transactions}
              onPress={() => onOpenAccount(acct.accountId)}
              onChange={() => bankFor(acct) && setLinking({ bank: bankFor(acct)!, current: { accountId: acct.accountId, budgetId: acct.budgetId } })}
              onUnlink={() => setUnlinking({ id: acct.accountId, name: acct.name, budgetId: acct.budgetId })}
            />
          ))}
        </View>
      )}

      {unlinked.length > 0 ? (
        <>
          <Text style={styles.sectionTitle}>Not linked</Text>
          <View style={styles.grid}>
            {unlinked.map((u) => (
              <View key={u.externalId} style={[styles.card, styles.cardOff]}>
                <View style={styles.cardHead}>
                  <View style={styles.flex}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {u.name}
                    </Text>
                    <Text style={styles.sub}>{`${u.type === 'CREDIT' ? 'Credit' : 'Bank'} account · not linked to a budget account`}</Text>
                  </View>
                </View>
                <BankBalanceOf bank={u} />
                <BankBill bank={u} />
                <View style={styles.controls}>
                  <Pressable
                    style={styles.primaryBtn}
                    accessibilityRole="button"
                    accessibilityLabel={`Link ${u.name} to a budget account`}
                    onPress={() => setLinking({ bank: u, current: null })}>
                    <Text style={styles.primaryBtnText}>Link to a budget account</Text>
                  </Pressable>
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}

      <LinkAccountSheet
        budgetId={budgetId}
        connectionId={connectionId}
        institution={institution}
        bank={linking?.bank ?? null}
        current={linking?.current ?? null}
        accounts={accounts}
        upstream={allUpstream}
        onClose={() => setLinking(null)}
      />
      <UnlinkAccountSheet budgetId={budgetId} account={unlinking} onClose={() => setUnlinking(null)} />
    </View>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: 'warn' | 'bad' }) {
  return (
    <View style={styles.stat}>
      <Text style={[styles.statValue, tone === 'warn' && { color: colors.yellowPillFg }, tone === 'bad' && { color: colors.redFg }]}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

function Counts({ c }: { c: ConnectionCountsJson }) {
  return (
    <View style={styles.counts}>
      <Stat label="Imported" value={c.importedCount} />
      <Stat label="Edited by you" value={c.editedCount} tone="warn" />
      <Stat label="Removed at bank" value={c.removedCount} tone="bad" />
    </View>
  );
}

/** Issuers report 0 for cards: bill/limit replaces the balance when known. */
function creditOf(bank: UpstreamAccountJson) {
  return bank.type === 'CREDIT' ? creditView(bank.credit) : null;
}

function BankBalanceOf({
  bank,
  budgetAccount,
  transactions,
}: {
  bank: UpstreamAccountJson;
  budgetAccount?: AccountRow | null;
  transactions?: TransactionRow[];
}) {
  if (creditOf(bank) || bank.balanceCents == null) return null;
  const linked = budgetAccount
    ? { reconcile: balanceReconcile(bank.balanceCents, budgetAccount), ...accountActivity(budgetAccount.id, transactions ?? []) }
    : null;
  return <BankBalanceCard balanceCents={bank.balanceCents} linked={linked} />;
}

function BankBill({ bank }: { bank: UpstreamAccountJson }) {
  const credit = creditOf(bank);
  return credit ? <CreditBillCard view={credit} /> : null;
}

function AccountCard({
  acct,
  bank,
  budgetAccount,
  transactions,
  onPress,
  onChange,
  onUnlink,
}: {
  acct: ConnectionAccountSummaryJson;
  bank: UpstreamAccountJson | null;
  budgetAccount: AccountRow | null;
  transactions: TransactionRow[];
  onPress: () => void;
  onChange: () => void;
  onUnlink: () => void;
}) {
  const { formatDate } = useMoneyFormat();
  const range = acct.firstDate && acct.lastDate ? `${formatDate(acct.firstDate)} – ${formatDate(acct.lastDate)}` : 'No transactions yet';
  return (
    // The open-tab press covers the content only; link controls sit outside it
    // so pressing them never also opens the tab.
    <View style={styles.card}>
      <Pressable onPress={onPress} style={styles.cardPress} accessibilityRole="button" accessibilityLabel={`Open ${bank?.name ?? acct.name}`}>
        <View style={styles.cardHead}>
          <View style={styles.flex}>
            <Text style={styles.cardTitle} numberOfLines={1}>
              {bank?.name ?? acct.name}
            </Text>
            <Text style={styles.sub} numberOfLines={1}>
              {`${bank ? (bank.type === 'CREDIT' ? 'Credit account' : 'Bank account') : 'Bank account'} → ${acct.name}`}
            </Text>
          </View>
        </View>
        {bank ? <BankBalanceOf bank={bank} budgetAccount={budgetAccount} transactions={transactions} /> : null}
        {bank ? <BankBill bank={bank} /> : null}
        <Counts c={acct} />
        <Text style={styles.sub}>{range}</Text>
      </Pressable>
      <View style={styles.controls}>
        <Text style={styles.linkedLine} numberOfLines={2}>{`Linked to ${acct.name}`}</Text>
        <Pressable style={styles.ghostBtn} accessibilityRole="button" accessibilityLabel={`Change link for ${bank?.name ?? acct.name}`} disabled={!bank} onPress={onChange}>
          <Text style={styles.ghostBtnText}>Change</Text>
        </Pressable>
        <Pressable style={styles.ghostBtn} accessibilityRole="button" accessibilityLabel={`Unlink ${acct.name}`} onPress={onUnlink}>
          <Text style={styles.ghostBtnText}>Unlink</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 12, paddingBottom: 24 },
  totals: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 16,
    padding: 12,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card,
  },
  sectionTitle: { color: colors.muted, fontSize: 12, fontWeight: '700', textTransform: 'uppercase' },
  hint: { color: colors.faint, fontSize: 13 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: {
    flexGrow: 1,
    flexBasis: 320,
    maxWidth: '100%',
    gap: 10,
    padding: 14,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border2,
    backgroundColor: colors.card,
  },
  cardPress: { gap: 10 },
  controls: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 10, borderTopWidth: 1, borderTopColor: colors.border },
  linkedLine: { flex: 1, minWidth: 120, color: colors.muted, fontSize: 12, fontWeight: '600' },
  ghostBtn: { borderWidth: 1, borderColor: colors.border2, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8 },
  ghostBtnText: { color: colors.indigo3, fontSize: 12, fontWeight: '700' },
  primaryBtn: { flex: 1, alignItems: 'center', backgroundColor: colors.indigo, borderRadius: 8, paddingHorizontal: 14, paddingVertical: 10 },
  primaryBtnText: { color: colors.white, fontSize: 12, fontWeight: '700' },
  cardOff: { borderStyle: 'dashed', backgroundColor: colors.bg },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  flex: { flex: 1, minWidth: 0 },
  cardTitle: { color: colors.text, fontSize: 15, fontWeight: '700' },
  sub: { color: colors.muted, fontSize: 12 },
  counts: { flexDirection: 'row', gap: 16, flexWrap: 'wrap' },
  stat: { gap: 1 },
  statValue: { color: colors.text, fontSize: 18, fontWeight: '800', fontVariant: ['tabular-nums'] },
  statLabel: { color: colors.faint, fontSize: 11 },
});
