/**
 * Pure view-model of the budget rail and shell: account sections with their
 * balances, and which budget becomes active when the persisted one is gone.
 * Reads wire rows (AccountRow / BudgetRow milliunits), so it lives beside the
 * rail rather than in domain/.
 */

import { milliToCents } from '@/budget/data/mapping';
import type { AccountRow, BudgetRow } from '@/budget/data/rows';
import { workingBalance } from '@/domain/engine';

/** Rail section order: CLOSED always last. */
const GROUP_ORDER: Record<string, number> = { CASH: 0, CREDIT: 1, CLOSED: 2 };

/** Display label per cash-family account type (the rail splits CASH by type). */
const TYPE_LABEL: Partial<Record<AccountRow['type'], string>> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
};

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
      push(`CASH:${a.type}`, TYPE_LABEL[a.type] ?? 'Cash', a);
    } else {
      push(a.account_group, a.account_group === 'CREDIT' ? 'Credit Cards' : 'Closed', a);
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

/**
 * The budget to switch to when the active id is missing or stale (budget
 * deleted server-side, DB reset), or null when the active one is fine or the
 * list is empty. Prefers the first non-archived budget: while Budgets
 * refetches after a fresh-start the not-yet-listed replacement must not be
 * bounced back to data[0] — which an archive reorder makes an archived budget.
 */
export function fallbackBudgetId(
  budgets: readonly Pick<BudgetRow, 'id' | 'archived_at'>[] | undefined,
  activeId: string | null | undefined,
): string | null {
  if (!budgets?.length) return null;
  if (activeId && budgets.some((b) => b.id === activeId)) return null;
  return budgets.find((b) => !b.archived_at)?.id ?? budgets[0].id;
}
