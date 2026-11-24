/**
 * AccountHeader — the Accounts screen's top bar: account title + edit pencil,
 * the '<type label> · reconciled status' subtitle (syscd-app-8uy), the owner
 * line, the Reconcile entry (button at desktop/tablet, ⋯ menu on phone) and
 * the cleared/uncleared/working balance formula.
 */

import type { RefObject } from 'react';
import { Pressable, StyleSheet, Text, View, type ViewInstance } from 'react-native';

import { Ionicons } from '@expo/vector-icons';

import type { Account, Budget, Cents } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import type { Person } from '@/domain/people';
import { IndigoButton } from '@/ui/bits';
import { BelongsTo } from '@/ui/PersonFace';
import { colors, radius } from '@/ui/theme';
import { AccountsMoreMenu } from './AccountsMoreMenu';
import { BalanceFormulaRow } from '@/ui/BalanceFormulaRow';
import { labels } from '@shared/i18n';
import { t } from './i18n';

// Header subtitle (syscd-app-8uy): '<type label> · reconciled status'.
const ACCOUNT_TYPE_LABEL: Record<Budget['accounts'][number]['type'], string> = labels(t, {
  checking: 'accountType.checking',
  savings: 'accountType.savings',
  cash: 'accountType.cash',
  credit: 'accountType.creditCard',
  tracking: 'accountType.tracking',
});

export function AccountHeader({
  isPhone,
  selectedAccount,
  owner,
  reconciling,
  topbarRef,
  reconcileBtnRef,
  onEditAccount,
  onReconcile,
  onImport,
  showReconciled,
  onToggleReconciled,
  totals,
  futureInstallments,
  unapprovedCount,
  showUnapprovedOnly,
  onToggleUnapprovedOnly,
}: {
  isPhone: boolean;
  /** Undefined = All Accounts. */
  selectedAccount: Account | undefined;
  /** The selected account's person (null = Shared). */
  owner: Person | null;
  reconciling: boolean;
  /** Phone popover anchor: the header row itself. */
  topbarRef: RefObject<ViewInstance | null>;
  /** Desktop popover anchor: the Reconcile button wrapper. */
  reconcileBtnRef: RefObject<ViewInstance | null>;
  onEditAccount: (accountId: string) => void;
  onReconcile: () => void;
  onImport: () => void;
  showReconciled: boolean;
  onToggleReconciled: (next: boolean) => void;
  totals: { cleared: Cents; uncleared: Cents; working: Cents };
  /** Sum of the selected card's upcoming installments (amount owed, cents); 0 hides the line. */
  futureInstallments: Cents;
  unapprovedCount: number;
  showUnapprovedOnly: boolean;
  onToggleUnapprovedOnly: () => void;
}) {
  const { formatDate, formatMoney } = useMoneyFormat();
  return (
    <View style={styles.topbar}>
      <View ref={topbarRef} collapsable={false} style={styles.topbarRow}>
        <View style={styles.topbarLeft}>
          <View style={styles.titleRow}>
            <Text
              style={[styles.title, isPhone && styles.titlePhone]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {selectedAccount ? selectedAccount.name : t('header.allAccounts')}
            </Text>
            {selectedAccount ? (
              <Pressable
                hitSlop={6}
                style={styles.iconBtn}
                onPress={() => onEditAccount(selectedAccount.id)}
                accessibilityRole="button"
                accessibilityLabel={t('header.editAccount', { name: selectedAccount.name })}
              >
                <Ionicons name="pencil" size={14} color={colors.faint} />
              </Pressable>
            ) : null}
            {/* tk-lj5l (spec item 9): on phone the header row is title +
              trailing ⋯ — every overflow action (File Import, Reconcile,
              Show Reconciled, Edit/Link Account) lives in the native
              AccountsMoreMenu; the title truncates so it never pushes
              the menu. Desktop keeps its own actions below. Web-phone
              additionally surfaces Reconcile as a visible button beside
              the ⋯ (user ask); on iOS both the button and the row-style
              override gate off `EXPO_OS === "web"`, so the native tree
              is unchanged. */}
            {isPhone ? (
              <View style={[styles.topbarTrail, process.env.EXPO_OS === 'web' && styles.topbarTrailWeb]}>
                {process.env.EXPO_OS === 'web' && selectedAccount && !reconciling ? (
                  <IndigoButton label={t('action.reconcile')} onPress={onReconcile} />
                ) : null}
                <AccountsMoreMenu
                  onImport={onImport}
                  onReconcile={selectedAccount && !reconciling ? onReconcile : undefined}
                  showReconciled={showReconciled}
                  onToggleReconciled={onToggleReconciled}
                  onEditAccount={
                    selectedAccount && !reconciling ? () => onEditAccount(selectedAccount.id) : undefined
                  }
                />
              </View>
            ) : null}
          </View>
          {selectedAccount ? (
            <Text style={styles.subtitle} numberOfLines={1} ellipsizeMode="tail">
              {ACCOUNT_TYPE_LABEL[selectedAccount.type]} ·{' '}
              {selectedAccount.lastReconciledAt
                ? t('header.lastReconciled', { date: formatDate(selectedAccount.lastReconciledAt.slice(0, 10)) })
                : t('header.notReconciled')}
            </Text>
          ) : null}
          {selectedAccount && futureInstallments > 0 ? (
            <Text style={styles.futureInstallments} numberOfLines={1} ellipsizeMode="tail">
              {t('header.futureInstallments', { amount: formatMoney(futureInstallments) })}
            </Text>
          ) : null}
          {selectedAccount ? (
            <BelongsTo person={owner} onPress={() => onEditAccount(selectedAccount.id)} />
          ) : null}
        </View>
        {/* Reconcile entry (syscd-app-8uy) — moved out of the View menu;
          hidden while the session banner is up. Trailing-aligned in the
          header row at desktop/tablet; phone reaches it through the ⋯
          menu (tk-lj5l). */}
        {!isPhone && selectedAccount && !reconciling ? (
          <View ref={reconcileBtnRef} collapsable={false} style={styles.reconcileBtnWrap}>
            <IndigoButton label={t('action.reconcile')} onPress={onReconcile} />
          </View>
        ) : null}
      </View>
      {isPhone ? (
        <>
          <BalanceFormulaRow
            hero
            compact
            cleared={totals.cleared}
            uncleared={totals.uncleared}
            working={totals.working}
          />
          {/* tk-lj5l (item 7): count row directly under the hero — same
            approval-queue filter as the banner's View action, no new
            state. Active state mirrors the banner's filter. */}
          {unapprovedCount > 0 ? (
            <Pressable
              style={[styles.unclearedRow, showUnapprovedOnly && styles.unclearedRowOn]}
              onPress={onToggleUnapprovedOnly}
              accessibilityRole="button"
              accessibilityState={{ selected: showUnapprovedOnly }}
              accessibilityLabel={t('header.toApproveLabel', { count: unapprovedCount })}
            >
              <Text style={[styles.unclearedText, showUnapprovedOnly && styles.unclearedTextOn]}>
                {t('header.toApprove', { count: unapprovedCount })}
              </Text>
            </Pressable>
          ) : null}
        </>
      ) : (
        <BalanceFormulaRow cleared={totals.cleared} uncleared={totals.uncleared} working={totals.working} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  topbar: {
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  title: { color: colors.text, fontSize: 20, fontWeight: '800' },
  titlePhone: { fontSize: 17, flexShrink: 1 },
  topbarTrail: { marginLeft: 'auto' },
  // Web-phone: the Reconcile button joins the trail, so items pack together
  // instead of pushing right.
  topbarTrailWeb: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  unclearedRow: {
    alignSelf: 'flex-start',
    marginTop: 2,
    paddingVertical: 3,
    paddingHorizontal: 10,
    borderRadius: radius.pill,
    backgroundColor: colors.indigoSoft,
  },
  unclearedRowOn: { backgroundColor: colors.indigo },
  unclearedText: { color: colors.indigo3, fontSize: 12, fontWeight: '700' },
  unclearedTextOn: { color: colors.white },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  subtitle: { color: colors.faint, fontSize: 12, marginTop: 2 },
  futureInstallments: { color: colors.muted, fontSize: 12, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  iconBtn: { padding: 4, borderRadius: radius.sm },
  // Reconcile sits at the trailing edge of the title row.
  reconcileBtnWrap: { marginLeft: 'auto' },
  topbarRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  topbarLeft: { flexGrow: 1, flexShrink: 1, minWidth: 0 },
});
