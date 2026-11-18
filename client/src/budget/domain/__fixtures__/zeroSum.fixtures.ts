/**
 * Scenario builder for zeroSum.test.ts so tests read like the spec tables.
 *
 * Conventions:
 * - Account id === account name; spending category id === category name.
 * - A card's payment category has id `payId(card)` and the SAME name as the
 *   card (so `cardAccountForCategory` links them), inside a group flagged
 *   `isCreditCardPayments`.
 * - Amounts are positive integer cents unless stated; `startingBalance` takes a
 *   signed balance (negative = card debt).
 * - `category.activity` is left `{}`: the engine under test must not read it.
 * - `build()` snapshots: account `clearedBalance` is the sum (inflow - outflow)
 *   of that account's non-upcoming transactions; `unclearedBalance` is 0.
 */
import type { Account, Budget, Category, CategoryGroup, MonthKey, Transaction } from "../types";

export const SPEND_GROUP_ID = "g-spend";
export const PAY_GROUP_ID = "g-pay";

/** Payment category id for a card account. */
export const payId = (card: string): string => `pay:${card}`;

/** MonthKey of an ISO date (YYYY-MM-DD). */
export const monthOf = (date: string): MonthKey =>
  Number(date.slice(0, 4)) * 100 + Number(date.slice(5, 7));

/** ISO date for a month key and day. */
export const dateIn = (month: MonthKey, day = 10): string =>
  `${Math.floor(month / 100)}-${String(month % 100).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

export interface ScenarioOptions {
  /** On-budget cash accounts (checking). */
  cash?: string[];
  /** Credit cards; each gets a payment category `payId(name)`. */
  cards?: string[];
  /** Spending category names. */
  categories?: string[];
  /** Off-budget (tracking) accounts. */
  offBudget?: string[];
}

export interface TxExtra {
  upcoming?: boolean;
}

export interface SplitLegInput {
  categoryId: string | null;
  /** Negative = outflow (spend), positive = inflow. */
  cents: number;
}

export class Scenario {
  private txs: Transaction[] = [];
  private assigned = new Map<string, Record<MonthKey, number>>();
  private seq = 0;

  constructor(private readonly opts: ScenarioOptions) {}

  /** Signed opening balance as an uncategorized row (negative = outflow = card debt). */
  startingBalance(account: string, cents: number, date: string): this {
    return this.push({
      accountId: account,
      date,
      payee: "Starting Balance",
      categoryId: null,
      outflow: cents < 0 ? -cents : 0,
      inflow: cents > 0 ? cents : 0,
    });
  }

  /** Money out of `account` (cents > 0); category null = uncategorized. */
  spend(account: string, category: string | null, cents: number, date: string, extra: TxExtra = {}): this {
    return this.push({ accountId: account, date, categoryId: category, outflow: cents, inflow: 0, ...extra });
  }

  /** Money into `account` (income or refund); category null = uncategorized. */
  inflow(account: string, category: string | null, cents: number, date: string, extra: TxExtra = {}): this {
    return this.push({ accountId: account, date, categoryId: category, outflow: 0, inflow: cents, ...extra });
  }

  /**
   * Transfer: BOTH mirrored legs, `transferAccountId` set on each, no category
   * (except `category`, applied to the on-budget leg, for off-budget cases).
   */
  transfer(
    from: string,
    to: string,
    cents: number,
    date: string,
    extra: TxExtra & { category?: string } = {},
  ): this {
    const { category, ...rest } = extra;
    const fromOnBudget = this.isOnBudget(from);
    this.push({
      accountId: from,
      date,
      payee: `Transfer : ${to}`,
      categoryId: fromOnBudget ? (category ?? null) : null,
      outflow: cents,
      inflow: 0,
      transferAccountId: to,
      ...rest,
    });
    return this.push({
      accountId: to,
      date,
      payee: `Transfer : ${from}`,
      categoryId: !fromOnBudget ? (category ?? null) : null,
      outflow: 0,
      inflow: cents,
      transferAccountId: from,
      ...rest,
    });
  }

  /** One split transaction; the parent carries categoryId null and the gross leg totals. */
  split(account: string, legs: SplitLegInput[], date: string, extra: TxExtra = {}): this {
    const splits = legs.map((l, i) => ({
      id: `sp${this.seq + 1}-${i}`,
      categoryId: l.categoryId,
      memo: "",
      outflow: l.cents < 0 ? -l.cents : 0,
      inflow: l.cents > 0 ? l.cents : 0,
    }));
    return this.push({
      accountId: account,
      date,
      categoryId: null,
      outflow: splits.reduce((s, l) => s + l.outflow, 0),
      inflow: splits.reduce((s, l) => s + l.inflow, 0),
      splits,
      ...extra,
    });
  }

  /** Raw escape hatch: any transaction fields over sane defaults. */
  add(partial: Partial<Transaction> & Pick<Transaction, "accountId" | "date">): this {
    return this.push(partial);
  }

  /** ADDS `cents` (may be negative) to the category's assignment for `month`. */
  assign(category: string, month: MonthKey, cents: number): this {
    const row = this.assigned.get(category) ?? {};
    row[month] = (row[month] ?? 0) + cents;
    this.assigned.set(category, row);
    return this;
  }

  /** Snapshot: a fresh Budget (safe to mutate) with balances equal to the sum of non-upcoming rows. */
  build(): Budget {
    const o = this.opts;
    const cash = o.cash ?? [];
    const cards = o.cards ?? [];
    const names = o.categories ?? [];
    const off = o.offBudget ?? [];

    const acct = (id: string, type: Account["type"], group: Account["group"], onBudget: boolean): Account => ({
      id,
      name: id,
      type,
      group,
      onBudget,
      clearedBalance: 0,
      unclearedBalance: 0,
      lastReconciledAt: null,
      userId: null,
    });
    const accounts: Account[] = [
      ...cash.map((n) => acct(n, "checking", "CASH", true)),
      ...cards.map((n) => acct(n, "credit", "CREDIT", true)),
      ...off.map((n) => acct(n, "tracking", "CASH", false)),
    ];

    const category = (id: string, name: string, groupId: string): Category => ({
      id,
      groupId,
      name,
      assigned: { ...(this.assigned.get(id) ?? {}) },
      activity: {},
    });
    const spending = names.map((n) => category(n, n, SPEND_GROUP_ID));
    const payments = cards.map((n) => category(payId(n), n, PAY_GROUP_ID));

    const groups: CategoryGroup[] = [{ id: SPEND_GROUP_ID, name: "Spending", categoryIds: names }];
    if (cards.length > 0) {
      groups.push({
        id: PAY_GROUP_ID,
        name: "Credit Card Payments",
        isCreditCardPayments: true,
        categoryIds: cards.map(payId),
      });
    }

    const monthSet = new Set<MonthKey>();
    for (const t of this.txs) monthSet.add(monthOf(t.date));
    for (const c of [...spending, ...payments]) for (const m of Object.keys(c.assigned)) monthSet.add(Number(m));
    const months = [...monthSet].sort((a, b) => a - b);

    return rebalance({
      id: "b",
      name: "Zero-sum scenario",
      currentMonth: months[months.length - 1] ?? 202606,
      months,
      groups,
      categories: [...spending, ...payments],
      bundles: [],
      accounts,
      transactions: structuredClone(this.txs),
    });
  }

  private isOnBudget(account: string): boolean {
    return !(this.opts.offBudget ?? []).includes(account);
  }

  private push(partial: Partial<Transaction> & Pick<Transaction, "accountId" | "date">): this {
    this.seq += 1;
    this.txs.push({
      id: `t${this.seq}`,
      payee: "",
      categoryId: null,
      memo: "",
      outflow: 0,
      inflow: 0,
      cleared: "cleared",
      approved: true,
      repeat: "never",
      repeatRuleId: null,
      upcoming: false,
      ...partial,
    });
    return this;
  }
}

export function scenario(opts: ScenarioOptions): Scenario {
  return new Scenario(opts);
}

/** Recompute every account's clearedBalance from its non-upcoming transactions (uncleared = 0). Returns the same budget. */
export function rebalance(budget: Budget): Budget {
  for (const a of budget.accounts) {
    a.clearedBalance = budget.transactions
      .filter((t) => t.accountId === a.id && !t.upcoming)
      .reduce((s, t) => s + t.inflow - t.outflow, 0);
    a.unclearedBalance = 0;
  }
  return budget;
}

/**
 * Copy of `budget` containing only data in months <= `month` (transactions and
 * assignments), with balances recomputed. The invariants I1 to I3 only hold on
 * such budgets.
 */
export function truncateBudget(budget: Budget, month: MonthKey): Budget {
  const copy = structuredClone(budget);
  copy.transactions = copy.transactions.filter((t) => monthOf(t.date) <= month);
  for (const c of copy.categories) {
    for (const k of Object.keys(c.assigned)) if (Number(k) > month) delete c.assigned[Number(k)];
  }
  copy.months = copy.months.filter((m) => m <= month);
  copy.currentMonth = month;
  return rebalance(copy);
}
