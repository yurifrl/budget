/**
 * Register rows for the Accounts screen: the desktop table row
 * (`RegisterRow`), the phone two-line card (`RegisterCard`) and the table
 * header (`RegisterHeader`). Both rows share the category pill, the signed
 * amount pill, the cleared badge and the row-menu kebab.
 */

import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import type { Person } from '@/domain/people';
import type { Account, Budget, Cents, Transaction } from '@/domain/types';
import { useMoneyFormat } from '@/ui/moneyFormat';
import { AccountOwnerFace } from '@/ui/PersonFace';
import { colors, radius } from '@/ui/theme';
import { ClearedBadge } from '@/ui/ClearedBadge';
import { TransferAutoLabel, TransferIcon } from '@/features/transfers';
import { TxnMenuKebab } from './register/TxnMenuKebab';
import { TxnMenuTrigger } from './register/TxnMenuTrigger';
import type { RegisterDensity } from './AccountsToolbar';
import { SelectionCheckbox } from '@/ui/SelectionCheckbox';
import { SignedAmountBox, tableStyles } from '@/ui/registerTable';
import { t } from './i18n';
import { displaySystemName } from '@/domain/systemNames';

/** What every register row needs, whatever its layout. */
interface RowBaseProps {
  txn: Transaction;
  budget: Budget;
  budgetId: string;
  /** The row's account (undefined when the account is gone). */
  account: Account | undefined;
  /** Category cell from `registerCategoryCell`. */
  category: { text: string; warn: boolean };
  density: RegisterDensity;
  /** Memo… from the native row menu: opens the edit sheet. */
  onEditMemo: () => void;
  onApprove: (txn: Transaction) => void;
  onToggleCleared: (txn: Transaction) => void;
  /** Kebab / right-click: open the row menu at this page point. */
  onOpenMenu: (txn: Transaction, pageX: number, pageY: number) => void;
  /** ⇄ on a row that looks like a transfer: open the transfer popover at this page point. */
  onOpenTransfer?: (txn: Transaction, pageX: number, pageY: number) => void;
}

/** Category pill plus the transfer bits (⇄ suggestion icon, "auto · payee rule"). */
function CategoryCell({ txn, category, onOpenTransfer }: Pick<RowBaseProps, 'txn' | 'category' | 'onOpenTransfer'>) {
  return (
    <>
      <Text style={[styles.tagPill, category.warn && styles.tagPillWarn, txn.transferAccountId && styles.tagPillTransfer]} numberOfLines={1}>
        {category.text}
      </Text>
      {txn.transferSuggestion && onOpenTransfer ? (
        <TransferIcon onOpen={(x, y) => onOpenTransfer(txn, x, y)} />
      ) : null}
      {txn.transferLinkMethod === 'rule' ? <TransferAutoLabel /> : null}
    </>
  );
}

/** Signed amount pill for a transaction. */
function RowAmount({ txn }: { txn: Transaction }) {
  const out = txn.outflow > 0;
  return <SignedAmountBox amount={out ? txn.outflow : txn.inflow} out={out} />;
}

/** Cleared badge wiring shared by both layouts: approve first, then cleared flips; reconciled rows are locked. */
function RowBadge({
  txn,
  compact,
  onApprove,
  onToggleCleared,
}: Pick<RowBaseProps, 'txn' | 'onApprove' | 'onToggleCleared'> & { compact?: boolean }) {
  return (
    <ClearedBadge
      compact={compact}
      status={txn.cleared}
      onApprove={txn.approved || txn.cleared === 'reconciled' ? undefined : () => onApprove(txn)}
      onToggle={txn.approved && txn.cleared !== 'reconciled' ? () => onToggleCleared(txn) : undefined}
    />
  );
}

/** Register table header (desktop). */
export function RegisterHeader({
  allSelected,
  onToggleAll,
  showOwnerSlot,
  showRunningBalance,
}: {
  allSelected: boolean;
  onToggleAll: () => void;
  showOwnerSlot: boolean;
  showRunningBalance: boolean;
}) {
  return (
    <View style={styles.reghd}>
      <SelectionCheckbox checked={allSelected} onToggle={onToggleAll} label={t('register.selectAll')} />
      <Text style={[styles.reghdText, { flex: 1.1 }, showOwnerSlot && { paddingLeft: 22 }]}>{t('register.colAccount')}</Text>
      <Text style={[styles.reghdText, { flex: 0.7 }]}>{t('register.colDate')}</Text>
      <Text style={[styles.reghdText, { flex: 1.4 }]}>{t('register.colPayee')}</Text>
      <Text style={[styles.reghdText, { flex: 1.4 }]}>{t('register.colCategory')}</Text>
      <Text style={[styles.reghdText, { flex: 1.2 }]}>{t('register.colMemo')}</Text>
      <Text style={[styles.reghdText, { flex: 1.1, textAlign: 'right' }]}>{t('register.colAmount')}</Text>
      {showRunningBalance ? (
        <Text style={[styles.reghdText, { width: 84, textAlign: 'right' }]}>{t('register.colRunningBalance')}</Text>
      ) : null}
      <Text style={[styles.reghdText, { width: 30, textAlign: 'center' }]}>{t('register.colCleared')}</Text>
      <Text style={[styles.reghdText, { width: 24 }]} />
    </View>
  );
}

/**
 * Phone layout: two stacked lines so long payees never crush the money pill
 * (tk-boxi). Line 1 = payee + Repeat + amount, line 2 = category + account.
 */
export function RegisterCard({
  txn: tx,
  budget,
  budgetId,
  account: acct,
  category: cat,
  density,
  showAccount,
  onEdit,
  onEditMemo,
  onApprove,
  onToggleCleared,
  onOpenMenu,
  onOpenTransfer,
}: RowBaseProps & {
  /** All Accounts: name the row's account on line 2. */
  showAccount: boolean;
  /** Card press: open the edit sheet (never called for reconciled rows). */
  onEdit: () => void;
}) {
  return (
    <TxnMenuTrigger txn={tx} budget={budget} budgetId={budgetId} onEditMemo={onEditMemo}>
      <Pressable
        style={[styles.txnCard, density === 'compact' && styles.txnCardCompact]}
        onPress={tx.cleared === 'reconciled' ? undefined : onEdit}
        accessibilityLabel={t('register.editLabel', { payee: displaySystemName(tx.payee) || t('register.noPayee') })}
        accessibilityState={{
          disabled: tx.cleared === 'reconciled',
        }}
      >
        <View style={styles.txnL1Phone}>
          <View style={styles.txnLeadPhone}>
            <Text style={styles.txnPayee} numberOfLines={1}>
              {displaySystemName(tx.payee) || t('register.noPayee')}
            </Text>
            {tx.upcoming ? <Text style={styles.upcomingPill}>{t('register.repeat')}</Text> : null}
          </View>
          <RowAmount txn={tx} />
          <RowBadge compact txn={tx} onApprove={onApprove} onToggleCleared={onToggleCleared} />
          <TxnMenuKebab onOpen={(px, py) => onOpenMenu(tx, px, py)} />
        </View>
        <View style={styles.txnL2Phone}>
          <CategoryCell txn={tx} category={cat} onOpenTransfer={onOpenTransfer} />
          {showAccount && acct ? (
            <Text style={styles.txnAcct} numberOfLines={1}>
              {acct.name}
            </Text>
          ) : null}
        </View>
      </Pressable>
    </TxnMenuTrigger>
  );
}

/** Desktop table row: one line, columns aligned with `RegisterHeader`. */
export function RegisterRow({
  txn: tx,
  budget,
  budgetId,
  account: acct,
  category: cat,
  density,
  selected,
  showOwnerSlot,
  owner,
  showRunningBalance,
  runningBalance,
  onPress,
  onToggleSelected,
  onEditMemo,
  onApprove,
  onToggleCleared,
  onOpenMenu,
  onOpenTransfer,
}: RowBaseProps & {
  selected: boolean;
  /** All Accounts with people in use: reserve the owner-face slot. */
  showOwnerSlot: boolean;
  owner: Person | null;
  showRunningBalance: boolean;
  /** Undefined = no running balance for this row (blank cell). */
  runningBalance: Cents | undefined;
  onPress: (txn: Transaction, e: GestureResponderEvent) => void;
  onToggleSelected: (id: string) => void;
}) {
  const { formatDate, formatMoney } = useMoneyFormat();
  return (
    <TxnMenuTrigger txn={tx} budget={budget} budgetId={budgetId} onEditMemo={onEditMemo}>
      <Pressable
        style={[
          styles.regrow,
          !tx.approved && { backgroundColor: colors.indigoSoft },
          tx.upcoming && styles.regrowUpcoming,
          density === 'compact' && styles.regrowCompact,
        ]}
        onPress={(e) => onPress(tx, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(tx, e.nativeEvent.pageX, e.nativeEvent.pageY);
        }}
        accessibilityLabel={t('register.editLabel', { payee: displaySystemName(tx.payee) || t('register.noPayee') })}
      >
        <SelectionCheckbox
          checked={selected}
          onToggle={() => onToggleSelected(tx.id)}
          label={t('register.selectLabel', { payee: displaySystemName(tx.payee) || t('register.noPayee') })}
        />
        <View style={[styles.regAcctCell, { flex: 1.1 }]}>
          {/* Fixed 16px slot so account names align whether or not the
              account has an owner (Shared shows no face). */}
          {showOwnerSlot && acct ? (
            <View style={styles.regAcctFace}>
              <AccountOwnerFace person={owner} size={16} />
            </View>
          ) : null}
          <Text style={[styles.regText, { flexShrink: 1 }]} numberOfLines={1}>
            {acct?.name}
          </Text>
        </View>
        <Text style={[styles.regText, { flex: 0.7, color: colors.muted }]}>{formatDate(tx.date)}</Text>
        <View
          style={{
            flex: 1.4,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Text style={[styles.regText, { flexShrink: 1 }]} numberOfLines={1}>
            {displaySystemName(tx.payee) || t('register.noPayee')}
          </Text>
          {tx.upcoming ? <Text style={styles.upcomingPill}>{t('register.repeat')}</Text> : null}
        </View>
        <View style={{ flex: 1.4, flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 }}>
          <CategoryCell txn={tx} category={cat} onOpenTransfer={onOpenTransfer} />
        </View>
        <Text style={[styles.regText, { flex: 1.2, color: colors.faint }]} numberOfLines={1}>
          {tx.memo}
        </Text>
        <View
          style={{
            flex: 1.1,
            flexDirection: 'row',
            justifyContent: 'flex-end',
          }}
        >
          <RowAmount txn={tx} />
        </View>
        {showRunningBalance ? (
          <Text style={[styles.regText, styles.runBal]}>
            {runningBalance !== undefined ? formatMoney(runningBalance) : ''}
          </Text>
        ) : null}
        <RowBadge txn={tx} onApprove={onApprove} onToggleCleared={onToggleCleared} />
        <TxnMenuKebab onOpen={(px, py) => onOpenMenu(tx, px, py)} />
      </Pressable>
    </TxnMenuTrigger>
  );
}

const styles = StyleSheet.create({
  regrowCompact: { paddingVertical: 2 },
  txnCardCompact: { paddingVertical: 5 },
  regAcctFace: { width: 16, height: 16 },
  regAcctCell: { flexDirection: 'row', alignItems: 'center', gap: 6, minWidth: 0 },
  runBal: { width: 84, textAlign: 'right', color: colors.muted },
  reghd: tableStyles.head,
  reghdText: tableStyles.headText,
  regrow: tableStyles.row,
  regText: tableStyles.text,
  // Upcoming repeat-rule occurrence (syscd-app-pya): dimmed row + Repeat chip.
  regrowUpcoming: { opacity: 0.55 },
  upcomingPill: {
    fontSize: 10,
    fontWeight: '700',
    paddingVertical: 1,
    paddingHorizontal: 7,
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
  tagPillTransfer: { backgroundColor: colors.bluePillBg, color: colors.blue },
  txnCard: {
    paddingHorizontal: 20,
    paddingVertical: 7,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  // Phone two-line row (tk-boxi): line 1 = payee + Repeat + amount, badge
  // trailing; line 2 = category + account under the payee.
  txnL1Phone: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 10,
  },
  txnLeadPhone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  txnL2Phone: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 3,
  },
  txnPayee: {
    color: colors.text,
    fontWeight: '600',
    fontSize: 13,
    flexShrink: 1,
    minWidth: 40,
  },
  txnAcct: { color: colors.faint, fontSize: 11, flexShrink: 1 },
});
