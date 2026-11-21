/**
 * The reconcile flow's two surfaces on the Accounts screen (syscd-app-mbi):
 * the confirm popover ("Is your current balance …?") and the session banner
 * (stated balance, live difference, Finish / Reconcile anyway).
 */

import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { Cents } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { GhostButton, IndigoButton, MoneyInput } from '@/ui/bits';
import { colors, radius } from '@/ui/theme';
import { tCommon } from '@shared/i18n/common';
import { t } from './i18n';

/**
 * Reconcile session banner (syscd-app-mbi): stated balance, live difference,
 * and the YNAB actions — Finish reconciling when balanced, Reconcile anyway
 * otherwise.
 */
export function ReconcileBanner({
  statedBalance,
  onStatedBalanceChange,
  diff,
  error,
  onCancel,
  onConfirm,
}: {
  statedBalance: Cents;
  onStatedBalanceChange: (cents: Cents) => void;
  /** Stated minus working balance; 0 = balanced. */
  diff: Cents;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  return (
    <View style={styles.banner}>
      <View style={styles.bannerMain}>
        <Text style={styles.kvLabel}>{t('reconcile.bankBalance')}</Text>
        <MoneyInput cents={statedBalance} onCommit={onStatedBalanceChange} autoFocus />
        <Text style={[styles.kvLabel, diff !== 0 && styles.bannerDiff]}>
          {diff === 0 ? t('reconcile.balanced') : t('reconcile.difference', { amount: formatMoney(diff) })}
        </Text>
        <View style={styles.bannerBtns}>
          <GhostButton label={tCommon('cancel')} onPress={onCancel} />
          <IndigoButton label={diff === 0 ? t('reconcile.finish') : t('reconcile.anyway')} onPress={onConfirm} />
        </View>
      </View>
      {error ? (
        <Text style={styles.reconcileError} accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Reconcile confirm backdrop + popover (syscd-app-mbi): YNAB semantics — Yes
 * reconciles everything instantly, No opens the statement-entry session. The
 * backdrop shows whenever an anchor exists; the card needs the account too.
 */
export function ReconcilePopover({
  anchor,
  workingBalance,
  onDismiss,
  onNo,
  onYes,
}: {
  /** Screen-root coordinates; null = closed. */
  anchor: { x: number; y: number } | null;
  /** The selected account's working balance; null = no account selected. */
  workingBalance: Cents | null;
  onDismiss: () => void;
  onNo: () => void;
  onYes: () => void;
}) {
  const { formatMoney } = useMoneyFormat();
  return (
    <>
      {anchor ? (
        <Pressable style={styles.scrimFill} onPress={onDismiss} accessibilityLabel={t('reconcile.closeQuestion')} />
      ) : null}
      {anchor && workingBalance != null ? (
        <View style={[styles.popover, { left: anchor.x, top: anchor.y }]}>
          <Text style={styles.popoverText}>
            {t('reconcile.question', { amount: formatMoney(workingBalance) })}
          </Text>
          <View style={styles.popoverBtns}>
            <GhostButton label={t('reconcile.no')} onPress={onNo} />
            <IndigoButton label={t('reconcile.yes')} onPress={onYes} />
          </View>
        </View>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  banner: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    backgroundColor: colors.card,
    borderTopWidth: 1,
    borderBottomWidth: 1,
    borderColor: colors.border,
    gap: 6,
  },
  bannerMain: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  bannerBtns: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bannerDiff: { color: colors.yellowPillFg, fontWeight: '700' },
  reconcileError: { color: colors.redFg, fontSize: 12 },
  kvLabel: { color: colors.muted, fontSize: 13 },
  scrimFill: { ...StyleSheet.absoluteFill, zIndex: 29 },
  popover: {
    position: 'absolute',
    zIndex: 30,
    backgroundColor: colors.card2,
    borderWidth: 1,
    borderColor: colors.border2,
    borderRadius: radius.sm,
    padding: 12,
    gap: 10,
    minWidth: 260,
  },
  popoverText: { color: colors.text, fontSize: 13, fontWeight: '600' },
  popoverBtns: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
});
