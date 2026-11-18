/**
 * Budget transfer payload — the canonical interchange shape between an
 * exported archive (Plan + Register TSVs) and a restored budget.
 *
 * Amounts are domain CENTS (integers); data/mapping restorePayloadToWire sends them as milliunits.
 */

import { monthKeyToDate } from '../data/mapping';
import { TRANSFER_PAYEE_RE } from '@shared/domain/transfers';
import type {
  Budget,
  ClearedStatus,
  Transaction,
} from '../domain/types';

export interface TransferPayloadCategory {
  groupIndex: number;
  name: string;
  hidden?: boolean;
  /** Owning member (null/absent = Shared). Ids are not portable: restore drops non-members. */
  userId?: string | null;
}

export interface TransferPayloadTransaction {
  accountIndex: number;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  payee: string;
  categoryIndex: number | null;
  memo: string;
  outflow: number;
  inflow: number;
  cleared: ClearedStatus;
  /** '' or label. */
  flag: string;
  /** Index into transactions[] of the peer leg of a transfer, or null. */
  transferPeerIndex: number | null;
}

export interface TransferPayloadAssignment {
  categoryIndex: number;
  /** First-of-month string (YYYY-MM-01). */
  month: string;
  budgeted: number;
}

export interface TransferPayload {
  groups: string[];
  categories: TransferPayloadCategory[];
  /** `userId`: the person the account belongs to (null/absent = Shared). */
  accounts: { name: string; userId?: string | null }[];
  transactions: TransferPayloadTransaction[];
  assignments: TransferPayloadAssignment[];
}

/**
 * Collapse split legs: a split parent exports as one row with summed
 * outflow/inflow and no category (the legs own categories and are not
 * representable in the flat register format).
 */
function collapsedAmounts(txn: Transaction): { outflow: number; inflow: number } {
  if (!txn.splits || txn.splits.length === 0) {
    return { outflow: txn.outflow, inflow: txn.inflow };
  }
  return {
    outflow: txn.splits.reduce((s, leg) => s + leg.outflow, 0),
    inflow: txn.splits.reduce((s, leg) => s + leg.inflow, 0),
  };
}

/**
 * Pair transfer candidates greedily: same date, swapped amounts, and each
 * side's payee names the other's account. Unpaired candidates keep their
 * payee text with transferPeerIndex null.
 */
export function pairTransfers(
  txns: { accountIndex: number; date: string; payee: string; outflow: number; inflow: number; transferPeerIndex: number | null }[],
  accountNames: string[],
): void {
  const nameToIndex = new Map(accountNames.map((n, i) => [n.toLowerCase(), i]));
  const candidates = txns
    .map((t, i) => ({ i, t, other: TRANSFER_PAYEE_RE.exec(t.payee)?.[1] ?? null }))
    .filter((c) => c.other !== null);
  for (const a of candidates) {
    if (a.t.transferPeerIndex !== null) continue;
    const aOther = nameToIndex.get(a.other!.toLowerCase());
    if (aOther === undefined) continue;
    for (const b of candidates) {
      if (b.i === a.i || b.t.transferPeerIndex !== null) continue;
      if (b.t.accountIndex !== aOther) continue;
      const bOther = nameToIndex.get(b.other!.toLowerCase());
      if (bOther === undefined || bOther !== a.t.accountIndex) continue;
      if (b.t.date !== a.t.date) continue;
      if (b.t.outflow !== a.t.inflow || b.t.inflow !== a.t.outflow) continue;
      a.t.transferPeerIndex = b.i;
      b.t.transferPeerIndex = a.i;
      break;
    }
  }
}

/** Payee of the synthetic row that carries an account's balance (see below). */
export const STARTING_BALANCE_PAYEE = 'Starting Balance';

/** Local `YYYY-MM-DD` for "today". */
function localIsoDate(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * An account's stored balance (cleared + uncleared) is NOT always the sum of
 * its ledger rows: a "working balance" edit overrides it directly, and a
 * brand-new account may have no rows at all. The register format only carries
 * rows, and restore re-derives balances from rows — so any difference (and the
 * very existence of a row-less account) would be lost. Emit one synthetic
 * uncleared "Starting Balance" row per account with a difference (amount 0 for
 * a row-less zero-balance account, which keeps the account in the register).
 */
function balanceRows(
  budget: Budget,
  transactions: TransferPayloadTransaction[],
  today: string,
): TransferPayloadTransaction[] {
  const rows: TransferPayloadTransaction[] = [];
  budget.accounts.forEach((account, accountIndex) => {
    let ledger = 0;
    let hasRows = false;
    for (const t of transactions) {
      if (t.accountIndex !== accountIndex) continue;
      hasRows = true;
      ledger += t.inflow - t.outflow;
    }
    const diff = account.clearedBalance + account.unclearedBalance - ledger;
    if (hasRows && diff === 0) return;
    rows.push({
      accountIndex,
      date: today,
      payee: STARTING_BALANCE_PAYEE,
      categoryIndex: null,
      memo: '',
      outflow: diff < 0 ? -diff : 0,
      inflow: diff > 0 ? diff : 0,
      cleared: 'uncleared',
      flag: '',
      transferPeerIndex: null,
    });
  });
  return rows;
}

/**
 * Reduce the Budget aggregate to the canonical TransferPayload. Amounts stay
 * in client cents; Available is derived by the engine, never re-computed here.
 */
export function budgetToPayload(budget: Budget, opts?: { now?: Date }): TransferPayload {
  const accounts = budget.accounts.map((a) => (a.userId ? { name: a.name, userId: a.userId } : { name: a.name }));
  const accountIndexById = new Map(budget.accounts.map((a, i) => [a.id, i]));

  const categories = budget.categories.map((c) => {
    const payload: TransferPayloadCategory = {
      groupIndex: budget.groups.findIndex((g) => g.id === c.groupId),
      name: c.name,
    };
    if (c.hidden) payload.hidden = true;
    if (c.userId) payload.userId = c.userId;
    return payload;
  });
  const categoryIndexById = new Map(budget.categories.map((c, i) => [c.id, i]));

  const transactions = budget.transactions.map((txn) => {
    const amounts = collapsedAmounts(txn);
    return {
      accountIndex: accountIndexById.get(txn.accountId) ?? -1,
      date: txn.date,
      payee: txn.payee,
      categoryIndex: txn.categoryId === null ? null : categoryIndexById.get(txn.categoryId) ?? null,
      memo: txn.memo,
      outflow: amounts.outflow,
      inflow: amounts.inflow,
      cleared: txn.cleared,
      flag: txn.flag ?? '',
      transferPeerIndex: null as number | null,
    };
  });
  pairTransfers(
    transactions,
    accounts.map((a) => a.name),
  );
  transactions.push(...balanceRows(budget, transactions, localIsoDate(opts?.now ?? new Date())));

  const assignments: TransferPayloadAssignment[] = [];
  budget.categories.forEach((category, categoryIndex) => {
    for (const [monthKey, cents] of Object.entries(category.assigned)) {
      // Sparse record: only months with a nonzero assignment carry meaning;
      // zero rows render in the Plan as plain zero cells instead.
      if (cents === 0) continue;
      assignments.push({ categoryIndex, month: monthKeyToDate(Number(monthKey)), budgeted: cents });
    }
  });

  return {
    groups: budget.groups.map((g) => g.name),
    categories,
    accounts,
    transactions,
    assignments,
  };
}
