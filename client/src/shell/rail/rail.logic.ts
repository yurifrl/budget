/**
 * Pure view-model of the budget rail and shell: account sections with their
 * balances, and whether the shell has a budget to show or must leave for the
 * home page. Reads wire rows (AccountRow milliunits, BudgetListRow), so it lives beside the
 * rail rather than in domain/.
 */

import { milliToCents } from '@/budget/data/mapping';
import type { AccountRow, BudgetListRow } from '@/budget/data/rows';
import { workingBalance } from '@/domain/engine';

import { t } from '../i18n';

/** Rail section order: CLOSED always last. */
const GROUP_ORDER: Record<string, number> = { CASH: 0, CREDIT: 1, CLOSED: 2 };

/** Display label per cash-family account type (the rail splits CASH by type). */
function typeLabel(type: AccountRow['type']): string {
  switch (type) {
    case 'checking':
      return t('rail.section.checking');
    case 'savings':
      return t('rail.section.savings');
    default:
      return t('rail.section.cash');
  }
}

export interface RailSection<A> {
  /** Collapse-state key: `CASH:<type>`, `CREDIT` or `CLOSED`. */
  key: string;
  label: string;
  accs: A[];
}

type SectionAccount = Pick<AccountRow, 'account_group' | 'type'>;

/**
 * Cash-family accounts split per type (Checking/Savings/Cash — a raw CASH
 * bucket reads wrong when every account is checking); CREDIT and CLOSED stay
 * whole, CLOSED rendering only when the Settings toggle enables it AND closed
 * accounts exist (YNAB parity, osb).
 */
export function railSections<A extends SectionAccount>(accounts: readonly A[], showClosedAccounts: boolean): RailSection<A>[] {
  const all = accounts.filter((a) => showClosedAccounts || a.account_group !== 'CLOSED');
  const sections: RailSection<A>[] = [];
  const push = (key: string, label: string, a: A) => {
    const existing = sections.find((s) => s.key === key);
    if (existing) existing.accs.push(a);
    else sections.push({ key, label, accs: [a] });
  };
  for (const a of all) {
    if (a.account_group === 'CASH') {
      push(`CASH:${a.type}`, typeLabel(a.type), a);
    } else {
      push(a.account_group, a.account_group === 'CREDIT' ? t('rail.section.creditCards') : t('rail.section.closed'), a);
    }
  }
  // YNAB order: cash-family sections, CREDIT, then CLOSED always last.
  return sections.sort(
    (x, y) => (GROUP_ORDER[x.key.split(':')[0]] ?? 9) - (GROUP_ORDER[y.key.split(':')[0]] ?? 9),
  );
}

type Balances = Pick<AccountRow, 'cleared_balance' | 'uncleared_balance'>;

/** One account's working balance in cents (each side converted, then summed). */
export function railAccountBalance(a: Balances): number {
  return workingBalance({
    clearedBalance: milliToCents(a.cleared_balance),
    unclearedBalance: milliToCents(a.uncleared_balance),
  } as never);
}

/** A section's header total in cents. */
export function railSectionTotal(accs: readonly Balances[]): number {
  return accs.reduce((sum, a) => sum + milliToCents(a.cleared_balance) + milliToCents(a.uncleared_balance), 0);
}

export type ShellGate = 'loading' | 'ready' | 'home';

/**
 * Whether the budget shell may render. It needs an active budget the caller
 * can reach; it never picks one itself: that choice starts on the home page
 * (`/`), which is also where a person with no budgets belongs.
 *
 * - `loading`: the persisted id is not restored yet, the list has not
 *   arrived, or the active id is missing from a list that is being
 *   refetched (a just-created budget must not be bounced, budget-fwf).
 * - `ready`: the active budget is listed (archived ones stay openable).
 * - `home`: no active budget, a stale one (deleted, access removed, another
 *   person signed in on this device), no budgets at all, or the list failed.
 */
export function shellGate(s: {
  restored: boolean;
  activeId: string | null | undefined;
  budgets: readonly Pick<BudgetListRow, 'id'>[] | undefined;
  isFetching: boolean;
  isError: boolean;
}): ShellGate {
  if (!s.restored) return 'loading';
  if (!s.activeId) return 'home';
  if (s.budgets?.some((b) => b.id === s.activeId)) return 'ready';
  if (s.isFetching) return 'loading';
  if (s.budgets === undefined && !s.isError) return 'loading';
  return 'home';
}

/**
 * Bank setup pages (Linked banks, a bank's page, Your Pluggy keys): no
 * transaction is entered there, and on a phone the floating "＋ Transaction"
 * pill sat on their bottom actions ("Connect another bank") and help text.
 */
const NO_TRANSACTION_FAB_ROUTES: readonly string[] = ['/connect-bank', '/connection', '/pluggy-keys'];

/** Whether the phone shell shows its "＋ Transaction" FAB on this route. */
export function showsTransactionFab(pathname: string): boolean {
  const path = pathname.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return !NO_TRANSACTION_FAB_ROUTES.includes(path);
}
