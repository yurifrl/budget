/**
 * Zero-sum budget engine (docs/budget-engine-spec.md). One pure entry point,
 * `computeBudgetMonth`, derives everything from `budget.transactions`,
 * `category.assigned` and account balances. It must not read
 * `category.activity`.
 *
 * One forward pass from the first ledger month to the requested month carries
 * per-category Available, per-payment-category Available and Ready to Assign
 * across each month boundary.
 */
import { monthOfDate, nextMonth } from "./format";
import { cardEnvelopeKey, isCardAccount, resolveCardLinks } from "./payments";
import type { Account, Budget, Cents, MonthKey, Transaction } from "./types";

export interface CategoryMonth {
  assigned: Cents;
  activity: Cents;
  carryover: Cents;
  available: Cents;
  cashOverspend: Cents;
  creditOverspend: Cents; // both >= 0
}

export interface PaymentMonth {
  accountId: string;
  assigned: Cents; // this month
  funded: Cents; // moved in this month (negative if net refunds)
  payments: Cents; // net paid to the card this month (>= 0 normally)
  available: Cents; // cumulative, P1
  debt: Cents; // max(0, -working balance)
  underfunded: Cents;
}

export interface BudgetMonth {
  month: MonthKey;
  readyToAssign: Cents;
  /** Spending categories only, keyed by category id. */
  categories: Record<string, CategoryMonth>;
  /** Card payment envelopes keyed by payment category id, or `card:<accountId>` for a card with no category (P8). */
  payments: Record<string, PaymentMonth>;
}

/** Net signed cents per card account id. */
type CardNets = Map<string, Cents>;

/** Everything the ledger says about one month, before any rule is applied. */
interface MonthLedger {
  /** Uncategorized cash-account net (R4). */
  uncategorized: Cents;
  /** Spending category id -> net on cash accounts. */
  cashNet: Map<string, Cents>;
  /** Spending category id -> net per card. */
  cardNet: Map<string, CardNets>;
  /** Card id -> net paid to it from cash accounts (P2). */
  payments: CardNets;
  /** Card id -> change of the card's ledger balance (L1). */
  balanceDelta: CardNets;
}


function addTo<K>(map: Map<K, Cents>, key: K, cents: Cents): void {
  map.set(key, (map.get(key) ?? 0) + cents);
}

function emptyLedger(): MonthLedger {
  return { uncategorized: 0, cashNet: new Map(), cardNet: new Map(), payments: new Map(), balanceDelta: new Map() };
}

const isCard = isCardAccount;

/** A transaction's category legs: its splits (L4), or itself. Signed net per leg. */
function legsOf(t: Transaction): { categoryId: string | null; net: Cents }[] {
  const parts = t.splits?.length ? t.splits : [{ categoryId: t.categoryId, outflow: t.outflow, inflow: t.inflow }];
  return parts.map((p) => ({ categoryId: p.categoryId, net: p.inflow - p.outflow }));
}

/** Fold the non-upcoming transactions into per-month ledgers (L1, L2, R4, R5, T1-T4). */
function buildLedgers(budget: Budget, spendingIds: ReadonlySet<string>): Map<MonthKey, MonthLedger> {
  const accounts = new Map(budget.accounts.map((a) => [a.id, a]));
  const ledgers = new Map<MonthKey, MonthLedger>();

  for (const t of budget.transactions) {
    const account = accounts.get(t.accountId);
    if (t.upcoming || !account?.onBudget) continue;
    const month = monthOfDate(t.date);
    let ledger = ledgers.get(month);
    if (!ledger) ledgers.set(month, (ledger = emptyLedger()));
    const card = isCard(account);
    const total = t.inflow - t.outflow;
    if (card) addTo(ledger.balanceDelta, account.id, total);

    const counterpart = t.transferAccountId ? accounts.get(t.transferAccountId) : undefined;
    if (counterpart?.onBudget) {
      // T2/T3/P6: transfers between budget accounts only matter as a payment
      // seen from the card side, and only when the other side is cash.
      if (card && !isCard(counterpart)) addTo(ledger.payments, account.id, total);
      continue;
    }

    for (const { categoryId, net } of legsOf(t)) {
      if (categoryId === null || !spendingIds.has(categoryId)) {
        if (!card) ledger.uncategorized += net; // R4; R5 on cards: no effect
      } else if (card) {
        let nets = ledger.cardNet.get(categoryId);
        if (!nets) ledger.cardNet.set(categoryId, (nets = new Map()));
        addTo(nets, account.id, net);
      } else {
        addTo(ledger.cashNet, categoryId, net);
      }
    }
  }
  return ledgers;
}

/** S7: split `credit` over cards by net spend; floor division, leftover to the largest spend (ties: lowest id). */
function splitCreditOverspend(spends: [string, Cents][], credit: Cents): Map<string, Cents> {
  const totalSpend = spends.reduce((sum, [, spend]) => sum + spend, 0);
  const shares = new Map<string, Cents>();
  let assigned = 0;
  for (const [id, spend] of spends) {
    const share = Number((BigInt(credit) * BigInt(spend)) / BigInt(totalSpend));
    shares.set(id, share);
    assigned += share;
  }
  const [largest] = [...spends].sort(([idA, a], [idB, b]) => b - a || (idA < idB ? -1 : 1));
  addTo(shares, largest[0], credit - assigned);
  return shares;
}

interface CategoryOutcome {
  view: CategoryMonth;
  /** Per card: spending moved into its payment category (S1/S2/S6). */
  funded: CardNets;
  /** Available carried into the next month (S4). */
  carry: Cents;
}

/** Apply S1-S6 to one category's month totals. */
function settleCategory(carryover: Cents, assigned: Cents, cashNet: Cents, cardNets: CardNets): CategoryOutcome {
  const cardTotal = [...cardNets.values()].reduce((sum, n) => sum + n, 0);
  const available = carryover + assigned + cashNet + cardTotal;
  const funded: CardNets = new Map();
  const spends: [string, Cents][] = [];
  for (const [card, net] of cardNets) {
    if (net < 0) spends.push([card, -net]);
    else funded.set(card, -net); // S6: net refunds always leave the payment category
  }

  let creditOverspend = 0;
  let cashOverspend = 0;
  let credit = new Map<string, Cents>();
  if (available < 0) {
    const cardSpend = spends.reduce((sum, [, spend]) => sum + spend, 0);
    creditOverspend = Math.min(-available, cardSpend); // S2
    cashOverspend = -available - creditOverspend;
    if (creditOverspend > 0) credit = splitCreditOverspend(spends, creditOverspend);
  }
  for (const [card, spend] of spends) funded.set(card, spend - (credit.get(card) ?? 0));

  return {
    view: { assigned, activity: cashNet + cardTotal, carryover, available, cashOverspend, creditOverspend },
    funded,
    carry: Math.max(0, available),
  };
}

const zeroCategory = (assigned: Cents): CategoryMonth => ({
  assigned,
  activity: 0,
  carryover: 0,
  available: 0,
  cashOverspend: 0,
  creditOverspend: 0,
});

/** First month with a non-upcoming transaction or an assignment (L3), if any. */
function firstLedgerMonth(budget: Budget, ledgers: Map<MonthKey, MonthLedger>): MonthKey | undefined {
  const months = [...ledgers.keys()];
  for (const c of budget.categories) months.push(...Object.keys(c.assigned).map(Number));
  return months.length > 0 ? Math.min(...months) : undefined;
}

export function computeBudgetMonth(budget: Budget, month: MonthKey): BudgetMonth {
  const links = resolveCardLinks(budget); // P8: the only place the card link is resolved
  const cardOf = new Map<string, Account>(links); // payment envelope key -> card
  const linkedCards = new Set([...links.values()].map((a) => a.id));
  for (const a of budget.accounts) if (isCard(a) && !linkedCards.has(a.id)) cardOf.set(cardEnvelopeKey(a.id), a);
  const spending = budget.categories.filter((c) => !links.has(c.id));
  const spendingIds = new Set(spending.map((c) => c.id));
  const categoryById = new Map(budget.categories.map((c) => [c.id, c]));
  const assignedIn = (id: string, m: MonthKey): Cents => categoryById.get(id)?.assigned[m] ?? 0;
  const ledgers = buildLedgers(budget, spendingIds);
  const first = firstLedgerMonth(budget, ledgers);

  const categoryCarry = new Map<string, Cents>();
  const paymentCarry = new Map<string, Cents>();
  const cardBalance = new Map<string, Cents>();
  let rta = 0;
  let result: BudgetMonth = {
    month,
    readyToAssign: 0,
    categories: Object.fromEntries(spending.map((c) => [c.id, zeroCategory(0)])),
    payments: Object.fromEntries(
      [...cardOf].map(([id, card]) => [
        id,
        { accountId: card.id, assigned: 0, funded: 0, payments: 0, available: 0, debt: 0, underfunded: 0 },
      ]),
    ),
  };
  if (first === undefined || month < first) return result;

  for (let m = first; m <= month; m = nextMonth(m)) {
    const ledger = ledgers.get(m) ?? emptyLedger();
    const categories: Record<string, CategoryMonth> = {};
    const payments: Record<string, PaymentMonth> = {};
    const fundedByCard: CardNets = new Map();
    let assignedTotal = 0;
    let nextSweep = 0; // cash overspend and negative payment Available leave RTA at rollover (S4, P5)

    for (const c of spending) {
      const outcome = settleCategory(
        categoryCarry.get(c.id) ?? 0,
        assignedIn(c.id, m),
        ledger.cashNet.get(c.id) ?? 0,
        ledger.cardNet.get(c.id) ?? new Map(),
      );
      categories[c.id] = outcome.view;
      categoryCarry.set(c.id, outcome.carry);
      assignedTotal += outcome.view.assigned;
      nextSweep += outcome.view.cashOverspend;
      for (const [card, cents] of outcome.funded) addTo(fundedByCard, card, cents);
    }

    let released = 0; // P7: funded spending absorbed by a positive card balance returns to RTA
    for (const [id, card] of cardOf) {
      const assigned = assignedIn(id, m);
      const paid = ledger.payments.get(card.id) ?? 0;
      const balance = (cardBalance.get(card.id) ?? 0) + (ledger.balanceDelta.get(card.id) ?? 0);
      // P7: payments settle the month's spending last, so the balance the spending
      // is measured against excludes this month's payments.
      const candidate = fundedByCard.get(card.id) ?? 0;
      const funded = candidate > 0 ? Math.min(candidate, Math.max(0, paid - balance)) : candidate;
      released += candidate - funded;
      const available = (paymentCarry.get(id) ?? 0) + assigned + funded - paid; // P1
      const debt = Math.max(0, -balance);
      cardBalance.set(card.id, balance);
      paymentCarry.set(id, Math.max(0, available));
      assignedTotal += assigned;
      nextSweep += Math.max(0, -available);
      payments[id] = {
        accountId: card.id,
        assigned,
        funded,
        payments: paid,
        available,
        debt,
        underfunded: Math.max(0, debt - Math.max(0, available)), // P4
      };
    }

    rta += ledger.uncategorized - assignedTotal + released;
    result = { month: m, readyToAssign: rta, categories, payments };
    rta -= nextSweep;
  }

  // R3: assignments dated after the viewed month already lower its RTA.
  const later = budget.categories.flatMap((c) => Object.entries(c.assigned));
  result.readyToAssign -= later.reduce((sum, [m, cents]) => (Number(m) > month ? sum + cents : sum), 0);
  return { ...result, month };
}

// ---------------------------------------------------------------------------
// Unified per-category figures, cached accessor
// ---------------------------------------------------------------------------

export type FigureKind = "spending" | "payment";

/** What every screen shows for one category in one month, spending or payment alike. */
export interface CategoryFigures {
  kind: FigureKind;
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

export interface FigureTotals {
  assigned: Cents;
  activity: Cents;
  available: Cents;
}

/**
 * Assigned / Activity / Available of one category from the engine's month. A
 * payment category's activity is what moved in minus what was paid
 * (`funded - payments`); its Available is `PaymentMonth.available`. An unknown
 * id is all zeros, as a spending category.
 */
export function categoryFigures(bm: BudgetMonth, categoryId: string): CategoryFigures {
  const payment = bm.payments[categoryId];
  if (payment) {
    return {
      kind: "payment",
      assigned: payment.assigned,
      activity: payment.funded - payment.payments,
      available: payment.available,
    };
  }
  const c = bm.categories[categoryId];
  return {
    kind: "spending",
    assigned: c?.assigned ?? 0,
    activity: c?.activity ?? 0,
    available: c?.available ?? 0,
  };
}

/** Sum of the unified figures over some categories (group, bundle, month roll-ups). */
export function sumFigures(bm: BudgetMonth, categoryIds: Iterable<string>): FigureTotals {
  const total: FigureTotals = { assigned: 0, activity: 0, available: 0 };
  for (const id of categoryIds) {
    const f = categoryFigures(bm, id);
    total.assigned += f.assigned;
    total.activity += f.activity;
    total.available += f.available;
  }
  return total;
}

const monthCache = new WeakMap<Budget, Map<MonthKey, BudgetMonth>>();

/**
 * `computeBudgetMonth` computed once per (budget, month). Budgets are
 * immutable snapshots from the store, so the budget object is the cache key
 * and a new snapshot starts empty.
 */
export function budgetMonth(budget: Budget, month: MonthKey): BudgetMonth {
  let months = monthCache.get(budget);
  if (!months) monthCache.set(budget, (months = new Map()));
  let bm = months.get(month);
  if (!bm) months.set(month, (bm = computeBudgetMonth(budget, month)));
  return bm;
}
