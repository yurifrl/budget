/**
 * Pure rules behind the account register (AccountsScreen, the linked-account
 * register): category cell text, row filtering and search.
 */

import { isInternalTransferPayee } from '@shared/domain/transfers';

import { computeRunningBalances, workingBalance } from './engine';
import { t as tr } from './i18n';
import { matchesSystemName } from './systemNames';
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
  t: Pick<Transaction, 'payee' | 'categoryId' | 'splits' | 'inflow'>,
  { transfers = true }: { transfers?: boolean } = {},
): { text: string; warn: boolean } {
  if (t.payee === 'Reconciliation Adjustment' || t.payee === 'Balance Adjustment') {
    return { text: tr('register.readyToAssign'), warn: false };
  }
  if (!t.categoryId) {
    if (t.splits?.length) return { text: tr('register.split', { count: t.splits.length }), warn: false };
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
 * Transactions" section (syscd-app-5nz); the rest stay in the list.
 */
export function splitScheduled(
  rows: Transaction[],
  today: string,
): { register: Transaction[]; scheduled: Transaction[] } {
  return {
    register: rows.filter((t) => t.date <= today),
    scheduled: rows.filter((t) => t.date > today),
  };
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
    transactions.filter((t) => t.date <= today),
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
