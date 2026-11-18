/**
 * Register rows for the Accounts screen: the desktop table row
 * (`RegisterRow`), the phone two-line card (`RegisterCard`) and the table
 * header (`RegisterHeader`). Both rows share the category pill, the signed
 * amount pill, the cleared badge and the row-menu kebab.
 */

import { Pressable, StyleSheet, Text, View, type GestureResponderEvent } from 'react-native';

import type { Person } from '../../domain/people';
import type { Account, Budget, Cents, Transaction } from '../../domain/types';
import { useMoneyFormat } from '../../model/useDisplayPrefs';
import { AccountOwnerFace } from '../../ui/PersonFace';
import { colors, radius } from '../../ui/theme';
import { ClearedBadge } from '../register/ClearedBadge';
import { TxnMenuKebab } from '../register/TxnMenuKebab';
import { TxnMenuTrigger } from '../register/TxnMenuTrigger';
import type { RegisterDensity } from './AccountsToolbar';
import { SelectionCheckbox } from './SelectionBar';

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
}

/** Signed amount pill (import-style): − red / + green, single AMOUNT column. */
function RowAmount({ txn }: { txn: Transaction }) {
  const { formatMoney } = useMoneyFormat();
  const out = txn.outflow > 0;
  return (
    <View style={[styles.amtBox, out ? styles.amtOut : styles.amtIn]}>
      <Text style={[styles.amtGlyph, out ? styles.amtOutGlyph : styles.amtInGlyph]}>{out ? '−' : '+'}</Text>
      <Text style={[styles.amtValue, out ? styles.amtOutValue : styles.amtInValue]} numberOfLines={1}>
        {formatMoney(out ? txn.outflow : txn.inflow)}
      </Text>
    </View>
  );
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
      <SelectionCheckbox checked={allSelected} onToggle={onToggleAll} label="Select all transactions" />
      <Text style={[styles.reghdText, { flex: 1.1 }, showOwnerSlot && { paddingLeft: 22 }]}>ACCOUNT</Text>
      <Text style={[styles.reghdText, { flex: 0.7 }]}>DATE</Text>
      <Text style={[styles.reghdText, { flex: 1.4 }]}>PAYEE</Text>
      <Text style={[styles.reghdText, { flex: 1.4 }]}>CATEGORY</Text>
      <Text style={[styles.reghdText, { flex: 1.2 }]}>MEMO</Text>
      <Text style={[styles.reghdText, { flex: 1.1, textAlign: 'right' }]}>AMOUNT</Text>
      {showRunningBalance ? (
        <Text style={[styles.reghdText, { width: 84, textAlign: 'right' }]}>RUN. BAL</Text>
      ) : null}
      <Text style={[styles.reghdText, { width: 30, textAlign: 'center' }]}>C</Text>
      <Text style={[styles.reghdText, { width: 24 }]} />
    </View>
  );
}

/**
 * Phone layout: two stacked lines so long payees never crush the money pill
 * (tk-boxi). Line 1 = payee + Repeat + amount, line 2 = category + account.
 */
export function RegisterCard({
  txn: t,
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
}: RowBaseProps & {
  /** All Accounts: name the row's account on line 2. */
  showAccount: boolean;
  /** Card press: open the edit sheet (never called for reconciled rows). */
  onEdit: () => void;
}) {
  return (
    <TxnMenuTrigger txn={t} budget={budget} budgetId={budgetId} onEditMemo={onEditMemo}>
      <Pressable
        style={[styles.txnCard, density === 'compact' && styles.txnCardCompact]}
        onPress={t.cleared === 'reconciled' ? undefined : onEdit}
        accessibilityLabel={`Edit transaction ${t.payee || '(no payee)'}`}
        accessibilityState={{
          disabled: t.cleared === 'reconciled',
        }}
      >
        <View style={styles.txnL1Phone}>
          <View style={styles.txnLeadPhone}>
            <Text style={styles.txnPayee} numberOfLines={1}>
              {t.payee || '(no payee)'}
            </Text>
            {t.upcoming ? <Text style={styles.upcomingPill}>Repeat</Text> : null}
          </View>
          <RowAmount txn={t} />
          <RowBadge compact txn={t} onApprove={onApprove} onToggleCleared={onToggleCleared} />
          <TxnMenuKebab onOpen={(px, py) => onOpenMenu(t, px, py)} />
        </View>
        <View style={styles.txnL2Phone}>
          <Text style={[styles.tagPill, cat.warn && styles.tagPillWarn]} numberOfLines={1}>
            {cat.text}
          </Text>
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
  txn: t,
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
    <TxnMenuTrigger txn={t} budget={budget} budgetId={budgetId} onEditMemo={onEditMemo}>
      <Pressable
        style={[
          styles.regrow,
          !t.approved && { backgroundColor: colors.indigoSoft },
          t.upcoming && styles.regrowUpcoming,
          density === 'compact' && styles.regrowCompact,
        ]}
        onPress={(e) => onPress(t, e)}
        onContextMenu={(e) => {
          e.preventDefault();
          onOpenMenu(t, e.nativeEvent.pageX, e.nativeEvent.pageY);
        }}
        accessibilityLabel={`Edit transaction ${t.payee || '(no payee)'}`}
      >
        <SelectionCheckbox
          checked={selected}
          onToggle={() => onToggleSelected(t.id)}
          label={`Select transaction ${t.payee || '(no payee)'}`}
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
        <Text style={[styles.regText, { flex: 0.7, color: colors.muted }]}>{formatDate(t.date)}</Text>
        <View
          style={{
            flex: 1.4,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <Text style={[styles.regText, { flexShrink: 1 }]} numberOfLines={1}>
            {t.payee || '(no payee)'}
          </Text>
          {t.upcoming ? <Text style={styles.upcomingPill}>Repeat</Text> : null}
        </View>
        <View style={{ flex: 1.4, flexDirection: 'row' }}>
          <Text style={[styles.tagPill, cat.warn && styles.tagPillWarn]} numberOfLines={1}>
            {cat.text}
          </Text>
        </View>
        <Text style={[styles.regText, { flex: 1.2, color: colors.faint }]} numberOfLines={1}>
          {t.memo}
        </Text>
        <View
          style={{
            flex: 1.1,
            flexDirection: 'row',
            justifyContent: 'flex-end',
          }}
        >
          <RowAmount txn={t} />
        </View>
        {showRunningBalance ? (
          <Text style={[styles.regText, styles.runBal]}>
            {runningBalance !== undefined ? formatMoney(runningBalance) : ''}
          </Text>
        ) : null}
        <RowBadge txn={t} onApprove={onApprove} onToggleCleared={onToggleCleared} />
        <TxnMenuKebab onOpen={(px, py) => onOpenMenu(t, px, py)} />
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
  reghd: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 20,
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
    paddingHorizontal: 20,
    paddingVertical: 5,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  regText: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  // Signed amount pill (import-style): − red / + green, single AMOUNT column.
  amtBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    borderWidth: 1,
    borderRadius: radius.sm,
    paddingVertical: 1,
    paddingHorizontal: 5,
    maxWidth: 118,
  },
  amtOut: { borderColor: colors.red, backgroundColor: colors.redPillBg },
  amtIn: { borderColor: colors.green, backgroundColor: colors.greenPillBg },
  amtGlyph: { fontSize: 13, fontWeight: '600' },
  amtOutGlyph: { color: colors.redFg },
  amtInGlyph: { color: colors.greenPillFg },
  amtValue: { color: colors.text, fontSize: 13, fontVariant: ['tabular-nums'] },
  amtOutValue: { color: colors.redFg },
  amtInValue: { color: colors.greenPillFg },
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
