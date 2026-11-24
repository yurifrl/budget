/**
 * Pure rules behind the account register (AccountsScreen, the linked-account
 * register): category cell text, row filtering and search.
 */

import { isInternalTransferPayee } from '@shared/domain/transfers';

import { computeRunningBalances, workingBalance } from './engine';
import { t as tr } from './i18n';
import { isReconciliationAdjustmentPayee, matchesSystemName } from './systemNames';
import type { Account, Budget, Cents, Transaction } from './types';

/**
 * Category cell text for a register row. YNAB shows every auto-booked
 * adjustment (reconcile or working-balance edit, including close zeroing)
 * categorized to Inflow: Ready to Assign. On-budget <-> on-budget transfers
 * carry no category by design and read "Transfer" (`transfers: false` skips
 * that check, as the linked-account register always did).
 */
export function registerCategoryCell(
  budget: Pick<Budget, 'accounts' | 'categories'>,
  t: Pick<Transaction, 'payee' | 'categoryId' | 'splits' | 'inflow' | 'transferPending'>,
  { transfers = true }: { transfers?: boolean } = {},
): { text: string; warn: boolean } {
  if (isReconciliationAdjustmentPayee(t.payee) || t.payee === 'Balance Adjustment') {
    return { text: tr('register.readyToAssign'), warn: false };
  }
  if (!t.categoryId) {
    if (t.splits?.length) return { text: tr('register.split', { count: t.splits.length }), warn: false };
    if (t.transferPending === 'waiting') return { text: tr('register.transferWaiting'), warn: false };
    if (t.transferPending === 'outside') return { text: tr('register.transferOutside'), warn: false };
    if (transfers && isInternalTransferPayee(t.payee, budget.accounts)) return { text: tr('register.transfer'), warn: false };
    return t.inflow > 0 ? { text: tr('register.readyToAssign'), warn: false } : { text: tr('register.needsCategory'), warn: true };
  }
  const cat = budget.categories.find((c) => c.id === t.categoryId);
  return { text: cat?.name ?? '?', warn: false };
}

/**
 * Rows in the register's scope, newest first. All Accounts hides
 * closed-account rows unless the View toggle is on (closed accounts are
 * immutable; YNAB parity); an explicit account selection always shows its
 * full register.
 */
export function scopeRegisterTxns(
  budget: Pick<Budget, 'accounts' | 'transactions'>,
  selectedAccountId: string | null,
  showClosedTxns: boolean,
): Transaction[] {
  const txns = selectedAccountId
    ? budget.transactions.filter((t) => t.accountId === selectedAccountId)
    : budget.transactions.filter((t) => {
        const group = budget.accounts.find((a) => a.id === t.accountId)?.group;
        return showClosedTxns || group !== 'CLOSED';
      });
  return [...txns].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

/** The register's view options and search, as the toolbar and banner set them. */
export interface RegisterFilter {
  /** Reconciled rows stay hidden unless View Options opts in. */
  showReconciled: boolean;
  /** Approval banner "View": unapproved rows only. */
  showUnapprovedOnly: boolean;
  /** Inclusive ISO bounds; '' = open. */
  dateFrom: string;
  dateTo: string;
  searchQuery: string;
}

/**
 * Register rows: the banner "View" filter (unapproved only) composed with the
 * view options and the toolbar search: payee / category / memo substrings,
 * plus an exact amount match when the query parses as money (`parseMoney` is
 * the user's locale parser).
 */
export function filterRegisterTxns(
  transactions: Transaction[],
  filter: RegisterFilter,
  categories: Budget['categories'],
  parseMoney: (input: string) => Cents,
): Transaction[] {
  let rows = transactions;
  // Reconciled rows stay hidden unless View Options opts in (syscd-app-lqu);
  // this is also what drops them right after a successful reconcile
  // (syscd-app-qfr).
  if (!filter.showReconciled) rows = rows.filter((t) => t.cleared !== 'reconciled');
  if (filter.showUnapprovedOnly) rows = rows.filter((t) => !t.approved);
  if (filter.dateFrom) rows = rows.filter((t) => t.date >= filter.dateFrom);
  if (filter.dateTo) rows = rows.filter((t) => t.date <= filter.dateTo);
  const q = filter.searchQuery.trim().toLowerCase();
  if (!q) return rows;
  const qCents = parseMoney(filter.searchQuery);
  return rows.filter((t) => {
    const cat = categories.find((c) => c.id === t.categoryId);
    if (qCents !== 0 && (t.inflow === qCents || t.outflow === qCents)) return true;
    return (
      matchesSystemName(t.payee ?? '', q) ||
      (cat?.name ?? '').toLowerCase().includes(q) ||
      (t.memo ?? '').toLowerCase().includes(q)
    );
  });
}

/**
 * Future-dated rows leave the register and render in the "Scheduled
 * Transactions" section (syscd-app-5nz); the rest stay in the list. Derived
 * upcoming card installments always go to Scheduled, even once their
 * projected date has passed: they are read-only placeholders, never register
 * rows (selection, bulk actions and the row editor work on stored rows).
 */
export function splitScheduled(
  rows: Transaction[],
  today: string,
): { register: Transaction[]; scheduled: Transaction[] } {
  const scheduled = (t: Transaction) => t.date > today || t.installment != null;
  return {
    register: rows.filter((t) => !scheduled(t)),
    scheduled: rows.filter(scheduled),
  };
}

/**
 * A derived installment's payee split for display: the purchase name and the
 * "kk/NN" fraction, so a narrow row can truncate the name and keep the
 * fraction visible. Null for any other row.
 */
export function installmentParts(t: Pick<Transaction, 'payee' | 'installment'>): { name: string; fraction: string } | null {
  if (!t.installment) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  const fraction = `${pad(t.installment.number)}/${pad(t.installment.total)}`;
  const payee = t.payee ?? '';
  const name = payee.endsWith(fraction) ? payee.slice(0, -fraction.length).trim() : payee.trim();
  return { name, fraction };
}

/**
 * Sum of the derived upcoming card installments in `transactions`, as a
 * positive amount owed (cents). The account header shows it as "Future
 * installments" when it is above zero.
 */
export function futureInstallmentsTotal(transactions: readonly Transaction[]): Cents {
  let total = 0;
  for (const t of transactions) if (t.installment) total += t.outflow - t.inflow;
  return total;
}

/**
 * Running balance (syscd-app-ojj, off by default): YNAB semantics, the
 * newest row's running balance equals the account's working balance and the
 * column walks backwards through the register. Computed over the account's
 * full register (not the filtered view) so search/option filters never
 * distort the numbers.
 */
export function registerRunningBalances(
  show: boolean,
  account: Account | undefined,
  transactions: Transaction[],
  today: string,
): Map<string, Cents> {
  if (!show || !account) return new Map<string, Cents>();
  return computeRunningBalances(
    transactions.filter((t) => t.date <= today && t.installment == null),
    workingBalance(account),
  );
}

/** Header balance formula totals over the accounts in scope. */
export function scopeBalances(accounts: readonly Account[]): { cleared: Cents; uncleared: Cents; working: Cents } {
  return {
    cleared: accounts.reduce((s, a) => s + a.clearedBalance, 0),
    uncleared: accounts.reduce((s, a) => s + a.unclearedBalance, 0),
    working: accounts.reduce((s, a) => s + workingBalance(a), 0),
  };
}
