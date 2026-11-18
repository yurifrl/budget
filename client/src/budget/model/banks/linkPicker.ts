/**
 * Pure logic behind the single-select bank-link picker, used in both
 * directions: pick ONE upstream bank account for a budget account (account
 * editor) or ONE budget account for an upstream bank account (bank page).
 *
 * Everything is flattened into `LinkOption`s so one component renders both.
 */

import type { ConnectionAccountSummaryJson, ConnectionUpstreamJson, UpstreamAccountJson } from '../../data/connections';
import type { AccountRow } from '../../data/rows';
import { milliToCents } from '../../data/mapping';
import { creditView, type CreditView } from './connections';

/** Budget-side working balance (cleared + uncleared) in cents. */
export function workingBalanceCents(account: Pick<AccountRow, 'cleared_balance' | 'uncleared_balance'>): number {
  return milliToCents(account.cleared_balance + account.uncleared_balance);
}

/**
 * The bank figure that is comparable to a budget account's working balance,
 * in the BUDGET's sign convention (null = nothing comparable).
 *  - BANK account: the reported balance.
 *  - CREDIT card: a budget card balance is negative debt, so compare against
 *    the negated limit used (what the card owes right now); when the issuer
 *    reports no usage, fall back to the negated current bill. Issuers report
 *    a 0 balance for cards, so that is never used.
 */
export function comparableBankCents(up: Pick<UpstreamAccountJson, 'type' | 'balanceCents' | 'credit'>): number | null {
  if (up.type === 'CREDIT') {
    const v = creditView(up.credit);
    if (v?.usedCents != null) return -v.usedCents;
    if (v?.billCents != null) return -v.billCents;
    return null;
  }
  return up.balanceCents;
}

export type MatchHint = { kind: 'match' } | { kind: 'diff'; diffCents: number };

/** "Matches your balance" / "R$ X different"; null when either side is unknown. */
export function matchHint(workingCents: number, bankCents: number | null): MatchHint | null {
  if (bankCents == null) return null;
  const diffCents = Math.abs(workingCents - bankCents);
  return diffCents === 0 ? { kind: 'match' } : { kind: 'diff', diffCents };
}

const CREDIT_TYPES: ReadonlySet<string> = new Set(['creditCard']);
const CASH_TYPES: ReadonlySet<string> = new Set(['checking', 'savings', 'cash']);

/**
 * Warning when the budget account's type clearly clashes with the bank
 * account's (card vs checking/savings/cash). Other budget types (loans,
 * assets…) are ambiguous, so they never warn. Never blocks the link.
 */
export function typeMismatchWarning(budgetType: string, upstreamType: 'BANK' | 'CREDIT'): string | null {
  if (upstreamType === 'CREDIT' && CASH_TYPES.has(budgetType)) return 'This is a credit card, but the budget account is a cash account';
  if (upstreamType === 'BANK' && CREDIT_TYPES.has(budgetType)) return 'This is a bank account, but the budget account is a credit card';
  return null;
}

const TYPE_LABELS: Record<string, string> = {
  checking: 'Checking',
  savings: 'Savings',
  cash: 'Cash',
  creditCard: 'Credit card',
  lineOfCredit: 'Line of credit',
  otherAsset: 'Other asset',
  otherLiability: 'Other liability',
  mortgage: 'Mortgage',
  autoLoan: 'Auto loan',
  studentLoan: 'Student loan',
  personalLoan: 'Personal loan',
  medicalDebt: 'Medical debt',
};

export function accountTypeLabel(type: string): string {
  return TYPE_LABELS[type] ?? 'Account';
}

export function upstreamTypeLabel(type: 'BANK' | 'CREDIT'): string {
  return type === 'CREDIT' ? 'Credit card' : 'Bank account';
}

/** One selectable (or disabled) row of the picker. */
export interface LinkOption {
  /** Unique within the picker: `<connectionId>:<externalId>` or the budget account id. */
  id: string;
  title: string;
  /** Bank name shown on the card itself (upstream rows). */
  institution: string | null;
  badge: string;
  /** Prominent balance; null when the figure is unknown. */
  balanceCents: number | null;
  /** Bill / limit details of a credit card. */
  credit: CreditView | null;
  hint: MatchHint | null;
  /** Name of what this row is already linked to; the row is then disabled. */
  linkedTo: string | null;
  warning: string | null;
}

export interface LinkOptionGroup {
  key: string;
  label: string;
  /** Set when the group's accounts could not be loaded (provider failed). */
  unavailable: string | null;
  options: LinkOption[];
}

export const upstreamOptionId = (connectionId: string, externalId: string) => `${connectionId}:${externalId}`;

/** One upstream account as an option, compared against `target` (null = no target to compare). */
export function upstreamOption(
  connectionId: string,
  institution: string | null,
  up: UpstreamAccountJson,
  target: AccountRow | null,
  budgetAccounts: AccountRow[],
): LinkOption {
  const linkedAccount = up.linkedAccountId != null && up.linkedAccountId !== target?.id
    ? budgetAccounts.find((a) => a.id === up.linkedAccountId)
    : null;
  const credit = up.type === 'CREDIT' ? creditView(up.credit) : null;
  return {
    id: upstreamOptionId(connectionId, up.externalId),
    title: up.name,
    institution: up.institution ?? institution,
    badge: upstreamTypeLabel(up.type),
    // Issuers report 0 for cards: the bill/limit block replaces the balance.
    balanceCents: credit ? null : up.balanceCents,
    credit,
    hint: target ? matchHint(workingBalanceCents(target), comparableBankCents(up)) : null,
    linkedTo: up.linkedAccountId != null && up.linkedAccountId !== target?.id ? (linkedAccount?.name ?? 'another account') : null,
    warning: target ? typeMismatchWarning(target.type, up.type) : null,
  };
}

/** Picker data for "pick the bank account that `target` follows", grouped by bank. */
export function upstreamOptionGroups(
  upstream: ConnectionUpstreamJson[],
  target: AccountRow,
  budgetAccounts: AccountRow[],
): LinkOptionGroup[] {
  return upstream.map((entry) => {
    const label = entry.connection.institution ?? entry.connection.provider;
    return {
      key: entry.connection.id,
      label,
      unavailable: entry.accounts == null ? `Could not load accounts from ${label} — sync or reconnect` : null,
      // Order is the bank's own: re-sorting by match would make rows jump as balances change.
      options: (entry.accounts ?? []).map((a) => upstreamOption(entry.connection.id, label, a, target, budgetAccounts)),
    };
  });
}

/**
 * Picker data for "pick the budget account that follows `bank`": open
 * accounts only, those already following another bank account disabled.
 */
export function accountOptionGroups(
  bank: UpstreamAccountJson,
  budgetAccounts: AccountRow[],
  upstream: ConnectionUpstreamJson[],
): LinkOptionGroup[] {
  const figure = comparableBankCents(bank);
  const bankNameFor = (acct: AccountRow): string => {
    for (const entry of upstream) {
      const hit = (entry.accounts ?? []).find((u) => u.linkedAccountId === acct.id);
      if (hit) return hit.name;
    }
    return acct.institution ?? 'a bank account';
  };
  const options = budgetAccounts
    .filter((a) => !a.closed && !a.deleted)
    .map((a): LinkOption => ({
      id: a.id,
      title: a.name,
      institution: null,
      badge: accountTypeLabel(a.type),
      balanceCents: workingBalanceCents(a),
      credit: null,
      hint: matchHint(workingBalanceCents(a), figure),
      linkedTo: a.connection_id != null ? bankNameFor(a) : null,
      warning: typeMismatchWarning(a.type, bank.type),
    }));
  return [{ key: 'budget', label: 'Budget accounts', unavailable: null, options }];
}

/**
 * The bank page's linked-account cards. The summary endpoint only lists
 * accounts that already hold imported rows, so a freshly linked account (or one
 * with only manual entries) is missing from it: synthesize an empty-count entry
 * from the live link so its link controls stay reachable.
 */
export function linkedSummaryAccounts(
  summaryAccounts: ConnectionAccountSummaryJson[],
  upstream: UpstreamAccountJson[] | null,
  budgetAccounts: AccountRow[],
): ConnectionAccountSummaryJson[] {
  const known = new Set(summaryAccounts.map((a) => a.accountId));
  const extra: ConnectionAccountSummaryJson[] = [];
  for (const up of upstream ?? []) {
    if (up.linkedAccountId == null || known.has(up.linkedAccountId)) continue;
    const acct = budgetAccounts.find((a) => a.id === up.linkedAccountId);
    if (!acct) continue;
    extra.push({
      accountId: acct.id,
      name: acct.name,
      type: acct.type,
      externalAccountId: up.externalId,
      balance: acct.cleared_balance + acct.uncleared_balance,
      importedCount: 0,
      editedCount: 0,
      removedCount: 0,
      totalCount: 0,
      firstDate: null,
      lastDate: null,
    });
  }
  return [...summaryAccounts, ...extra];
}
