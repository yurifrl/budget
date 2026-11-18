import { describe, it, expect } from "bun:test";
import {
  assignedInMonth,
  computeRunningBalances,
  costToBeMe,
  groupRollup,
  neededInMonth,
  recomputeActivity,
  targetFundingState,
  workingBalance,
} from "./engine";
import { createSeedBudget } from "./seed";
import type { Budget, Category, CategoryTarget, MonthKey } from "./types";
import { budgetMonth, categoryFigures, computeBudgetMonth } from "./zeroSum";
import { dateIn, payId, scenario } from "./zeroSum.fixtures";

const M: MonthKey = 202606;
const PREV: MonthKey = 202605;

/** Unified-target fixture factories (categoryId kept in sync with the category id). */
const monthly = (amountCents: number, id = "c"): CategoryTarget => ({
  categoryId: id,
  kind: "monthly",
  amountCents,
  config: {},
});
const byDate = (amountCents: number, iso: string, id = "c"): CategoryTarget => ({
  categoryId: id,
  kind: "custom",
  amountCents,
  config: { byDate: iso },
});

/** Minimal category factory for focused unit tests. */
function cat(partial: Partial<Category>): Category {
  return {
    id: partial.id ?? "c",
    groupId: partial.groupId ?? "g",
    name: partial.name ?? "Cat",
    assigned: partial.assigned ?? {},
    activity: partial.activity ?? {},
    target: partial.target,
    notes: partial.notes,
  };
}

/** Minimal single-category, single-account budget for RTA tests. */
function budgetWith(category: Category, funds: number): Budget {
  return {
    bundles: [],
    id: "b",
    name: "B",
    currentMonth: M,
    months: [M],
    groups: [{ id: "g", name: "G", categoryIds: [category.id] }],
    categories: [category],
    accounts: [
      {
        id: "a",
        name: "A",
        type: "checking",
        group: "CASH",
        onBudget: true,
        clearedBalance: funds,
        unclearedBalance: 0,
        lastReconciledAt: null, userId: null,
      },
    ],
    transactions: [],
  };
}

describe("workingBalance", () => {
  it("sums cleared and uncleared", () => {
    const b = budgetWith(cat({}), 0);
    b.accounts[0].clearedBalance = 1000;
    b.accounts[0].unclearedBalance = 250;
    expect(workingBalance(b.accounts[0])).toBe(1250);
  });

  it("handles negative (credit) uncleared", () => {
    const b = budgetWith(cat({}), 0);
    b.accounts[0].clearedBalance = -5000;
    b.accounts[0].unclearedBalance = -1000;
    expect(workingBalance(b.accounts[0])).toBe(-6000);
  });
});

describe("computeRunningBalances", () => {
  const row = (id: string, outflow: number, inflow = 0) => ({ id, outflow, inflow });

  it("seeds the newest row with the working balance and walks backwards", () => {
    // Register order: newest first. Nets: t1 −1000, t2 +2000, t3 −500.
    const rows = [row("t3", 500), row("t2", 0, 2000), row("t1", 1000)];
    const map = computeRunningBalances(rows, 1000);
    expect(map.get("t3")).toBe(1000); // newest = working balance
    expect(map.get("t2")).toBe(1000 - (0 - 500)); // minus t3's net (outflow increases it)
    expect(map.get("t1")).toBe(1500 - 2000); // minus t2's net (inflow decreases it)
  });

  it("walks every row to the opening balance", () => {
    const rows = [row("t3", 500), row("t2", 0, 2000), row("t1", 1000)];
    const map = computeRunningBalances(rows, 1000);
    // Balance after t1 + t1's net = opening (balance before any txn).
    const opening = map.get("t1")! - (0 - 1000);
    expect(opening).toBe(500); // working 1000 = opening 500 + Σnets 500
  });

  it("returns an empty map for no rows", () => {
    expect(computeRunningBalances([], 5000).size).toBe(0);
  });
});

const d = (m: MonthKey, day = 10): string => dateIn(m, day);

/** One cash account, one card with its payment category, one spending category "c". */
const base = () =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["c"] }).startingBalance("Checking", 100000, d(PREV, 1));

/** The pill the engine's month gives category `id`, after stamping `target` on it. */
function pill(b: Budget, id: string, month: MonthKey, target?: CategoryTarget) {
  const c = b.categories.find((x) => x.id === id)!;
  if (target) c.target = target;
  return targetFundingState(c, budgetMonth(b, month));
}

describe("category figures over the engine (ported from the old carryover / Available tests)", () => {
  it("available is carryover + assigned + activity for the month (S4 carry, positive Available)", () => {
    const b = base()
      .assign("c", PREV, 10000)
      .spend("Checking", "c", 8000, d(PREV))
      .assign("c", M, 20000)
      .spend("Checking", "c", 5000, d(M))
      .build();
    // prev: 10000 - 8000 = 2000 carries; this month 2000 + 20000 - 5000.
    const bm = budgetMonth(b, M);
    expect(bm.categories["c"].carryover).toBe(2000);
    expect(categoryFigures(bm, "c")).toEqual({ kind: "spending", assigned: 20000, activity: -5000, available: 17000 });
  });

  it("assignments in later months do not count towards this month's Available", () => {
    const b = base().assign("c", M, 20000).assign("c", 202607, 50000).build();
    expect(categoryFigures(budgetMonth(b, M), "c").available).toBe(20000);
  });
});

describe("neededInMonth", () => {
  it("monthly target needs the full amount every month", () => {
    const c = cat({ target: monthly(30000) });
    expect(neededInMonth(c, M)).toBe(30000);
  });

  it("by-date target needs full amount until due, then zero", () => {
    const c = cat({
      target: byDate(80000, "2026-06-30"),
    });
    expect(neededInMonth(c, M)).toBe(80000);
    expect(neededInMonth(c, 202607)).toBe(0);
  });

  it("is zero with no target", () => {
    expect(neededInMonth(cat({}), M)).toBe(0);
  });
});

describe("targetFundingState", () => {
  it("GREEN when assigned meets the target", () => {
    const b = base().assign("c", M, 30000).build();
    const r = pill(b, "c", M, monthly(30000));
    expect(r.state).toBe("green");
    expect(r.gap).toBe(0);
  });

  it("stays GREEN after a funded category is spent down (assigned vs target, not available)", () => {
    const b = base().assign("c", M, 30000).spend("Checking", "c", 30000, d(M)).build();
    const r = pill(b, "c", M, monthly(30000)); // fully spent => available 0
    expect(categoryFigures(budgetMonth(b, M), "c").available).toBe(0);
    expect(r.state).toBe("green");
    expect(r.fundedSoFar).toBe(30000);
  });

  it("YELLOW when underfunded, with the correct gap", () => {
    const b = base().assign("c", M, 10000).build();
    const r = pill(b, "c", M, monthly(30000));
    expect(r.state).toBe("yellow");
    expect(r.neededThisMonth).toBe(30000);
    expect(r.fundedSoFar).toBe(10000);
    expect(r.gap).toBe(20000);
  });

  it("YELLOW with full gap when a target exists but nothing is assigned", () => {
    const r = pill(base().build(), "c", M, byDate(80000, "2026-06-30"));
    expect(r.state).toBe("yellow");
    expect(r.gap).toBe(80000);
  });

  it("S5: RED when the category is overspent in cash, even with a target met", () => {
    // assigned 5000, 9000 spent from checking: cashOverspend 4000.
    const b = base().assign("c", M, 5000).spend("Checking", "c", 9000, d(M)).build();
    const r = pill(b, "c", M, monthly(5000));
    expect(categoryFigures(budgetMonth(b, M), "c").available).toBe(-4000);
    expect(r.state).toBe("red");
  });

  it("S5: RED cash overspend with no target", () => {
    const b = base().assign("c", M, 5000).spend("Checking", "c", 9000, d(M)).build();
    expect(pill(b, "c", M).state).toBe("red");
  });

  it("S5: overspending that falls on the card is the credit state, not red, and wins over a met target", () => {
    // assigned 5000, 9000 on the card: creditOverspend 4000, cashOverspend 0.
    const b = base().assign("c", M, 5000).spend("Card", "c", 9000, d(M)).build();
    const withTarget = pill(b, "c", M, monthly(5000)); // assigned 5000 >= needed 5000 would be green
    expect(categoryFigures(budgetMonth(b, M), "c").available).toBe(-4000);
    expect(withTarget.state).toBe("credit");
    expect(pill(b, "c", M, undefined).state).toBe("credit");
  });

  it("S5: any cash overspend is red even when credit overspend is also present (G4)", () => {
    // available 100, cash 120 + card 50: cashOverspend 20, creditOverspend 50.
    const b = base().assign("c", M, 10000).spend("Checking", "c", 12000, d(M)).spend("Card", "c", 5000, d(M)).build();
    const cm = budgetMonth(b, M).categories["c"];
    expect([cm.cashOverspend, cm.creditOverspend]).toEqual([2000, 5000]);
    expect(pill(b, "c", M).state).toBe("red");
  });

  it("GRAY when no target and nothing available", () => {
    expect(pill(base().build(), "c", M).state).toBe("gray");
  });

  it("GREEN when no target but positive available", () => {
    expect(pill(base().assign("c", M, 6000).build(), "c", M).state).toBe("green");
  });

  describe("card payment categories", () => {
    const PAY = payId("Card");
    const payPill = (b: Budget, month: MonthKey) => targetFundingState(b.categories.find((c) => c.id === PAY)!, budgetMonth(b, month));

    it("RED when Available is negative (paid more than was available, P5)", () => {
      const b = base().spend("Card", "c", 4000, d(M)).transfer("Checking", "Card", 9000, d(M)).build();
      expect(budgetMonth(b, M).payments[PAY].available).toBeLessThan(0);
      expect(payPill(b, M).state).toBe("red");
    });

    it("YELLOW with the underfunded amount when card debt is not covered (P4)", () => {
      // debt 20000 (starting balance), 5000 assigned: underfunded 15000.
      const b = base().startingBalance("Card", -20000, d(PREV, 1)).assign(PAY, M, 5000).build();
      const r = payPill(b, M);
      expect(r.state).toBe("yellow");
      expect(r.underfunded).toBe(15000);
    });

    it("GREEN for positive Available once the debt is covered, GRAY for zero", () => {
      const covered = base().startingBalance("Card", -20000, d(PREV, 1)).assign(PAY, M, 25000).build();
      expect(payPill(covered, M)).toMatchObject({ state: "green" });
      expect(payPill(covered, M).underfunded).toBeUndefined();
      expect(payPill(base().build(), M).state).toBe("gray");
    });
  });
});

describe("costToBeMe", () => {
  it("sums all category targets for the month", () => {
    const b = budgetWith(cat({}), 0);
    b.categories = [
      cat({ id: "a", target: monthly(30000, "a") }),
      cat({ id: "b", target: monthly(20000, "b") }),
      cat({ id: "c" }), // no target
    ];
    expect(costToBeMe(b, M)).toBe(50000);
  });
});

describe("recomputeActivity", () => {
  it("folds transactions into per-category per-month signed activity", () => {
    const b = budgetWith(cat({ id: "cat-x" }), 0);
    b.transactions = [
      {
        id: "t1",
        accountId: "a",
        date: "2026-06-05",
        payee: "Loja",
        categoryId: "cat-x",
        memo: "",
        outflow: 5000,
        inflow: 0,
        cleared: "cleared",
        approved: true,
        repeat: "never",
        repeatRuleId: null,
        upcoming: false,
      },
      {
        id: "t2",
        accountId: "a",
        date: "2026-06-08",
        payee: "Reembolso",
        categoryId: "cat-x",
        memo: "",
        outflow: 0,
        inflow: 2000,
        cleared: "cleared",
        approved: true,
        repeat: "never",
        repeatRuleId: null,
        upcoming: false,
      },
    ];
    const activity = recomputeActivity(b);
    expect(activity["cat-x"][M]).toBe(-3000);
  });

  it("excludes upcoming repeat-rule occurrences from activity (syscd-app-pya)", () => {
    const b = budgetWith(cat({ id: "cat-x" }), 0);
    b.transactions = [
      {
        id: "t1",
        accountId: "a",
        date: "2026-06-01",
        payee: "Aluguel",
        categoryId: "cat-x",
        memo: "",
        outflow: 5000,
        inflow: 0,
        cleared: "uncleared",
        approved: true,
        repeat: "monthly",
        repeatRuleId: "rule-qa",
        upcoming: true,
      },
    ];
    expect(recomputeActivity(b)["cat-x"]).toBeUndefined();
  });

  it("ignores uncategorized transactions", () => {
    const b = budgetWith(cat({ id: "cat-x" }), 0);
    b.transactions = [
      {
        id: "t1",
        accountId: "a",
        date: "2026-06-05",
        payee: "PIX",
        categoryId: null,
        memo: "",
        outflow: 5000,
        inflow: 0,
        cleared: "uncleared",
        approved: false,
        repeat: "never",
        repeatRuleId: null,
        upcoming: false,
      },
    ];
    expect(recomputeActivity(b)["cat-x"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Integration against the real seed
// ---------------------------------------------------------------------------

describe("seed budget", () => {
  const b = createSeedBudget();
  const byId = (id: string) => b.categories.find((c) => c.id === id)!;
  const bm = budgetMonth(b, M);
  const pillOf = (id: string) => targetFundingState(byId(id), bm);
  const balance = (id: string) => {
    const a = b.accounts.find((x) => x.id === id)!;
    return a.clearedBalance + a.unclearedBalance;
  };

  it("every account balance equals the sum of its transactions (L1)", () => {
    for (const a of b.accounts) {
      const ledger = b.transactions.filter((t) => t.accountId === a.id).reduce((s, t) => s + t.inflow - t.outflow, 0);
      expect(balance(a.id)).toBe(ledger);
    }
  });

  it("the card payment is a linked transfer: both legs carry transferAccountId", () => {
    const legs = b.transactions.filter((t) => t.transferAccountId);
    expect(legs.map((t) => [t.accountId, t.transferAccountId, t.inflow - t.outflow])).toEqual([
      ["acc-itau-cc", "acc-nubank", -100000],
      ["acc-nubank", "acc-itau-cc", 100000],
    ]);
  });

  // Hand-computed (zero-sum). Uncategorized checking income: Starting Balance
  // 500000 + two Salário 1380000 - the June PIX 5500 = 3254500 (the card's
  // Starting Balance has no budget effect, R5). Assigned 483000 (Mes) + 200000
  // (Itau Cartão) = 683000 in total. No month ends with a cash overspend (Comer
  // Fora's 4000 is credit overspending), so nothing is swept: 3254500 - 683000
  // = 2571500.
  it("Ready to Assign is R$25.715,00 under the zero-sum model", () => {
    expect(bm.readyToAssign).toBe(2571500);
  });

  it("I1 on the seed: cash = RTA + spending Available + credit overspend + payment Available", () => {
    // 2936500 = 2571500 + 91000 + 4000 + 270000
    expect(balance("acc-itau-cc")).toBe(
      bm.readyToAssign +
        Object.values(bm.categories).reduce((sum, c) => sum + c.available + c.creditOverspend, 0) +
        Object.values(bm.payments).reduce((sum, p) => sum + p.available, 0),
    );
  });

  it("renders the full pill spectrum in 202606", () => {
    expect(pillOf("cat-academia").state).toBe("green");
    expect(pillOf("cat-mercado").state).toBe("green");
    expect(pillOf("cat-farmacia").state).toBe("green");
    expect(pillOf("cat-saude").state).toBe("green");
    expect(pillOf("cat-celular").state).toBe("green");

    expect(pillOf("cat-psiquiatra").state).toBe("yellow");
    expect(pillOf("cat-transporte").state).toBe("yellow");
    expect(pillOf("cat-ifood").state).toBe("yellow");

    expect(pillOf("cat-diversao").state).toBe("gray");
    // Comer Fora: 5000 assigned, 9000 on the card: credit overspending only (S5).
    expect(pillOf("cat-comer-fora").state).toBe("credit");
    // Itau Cartão: debt 345369, Available 270000: underfunded 75369 (P4).
    expect(pillOf("cat-nubank-payment")).toMatchObject({ state: "yellow", underfunded: 75369 });
  });

  it("Psiquiatra needs R$800,00 by the 30th", () => {
    const r = pillOf("cat-psiquiatra");
    expect(r.gap).toBe(80000);
    expect(byId("cat-psiquiatra").target?.config.byDate).toBe("2026-06-30");
  });

  it("Academia stays green though available is 0 (spent down)", () => {
    expect(categoryFigures(bm, "cat-academia").available).toBe(0);
    expect(pillOf("cat-academia").state).toBe("green");
  });

  // Hand-computed from the seed fixture, NOT re-run through categoryFigures.
  // Per category at 202606, available = Σ over months ≤ 202606 of
  // (assigned + activity), none of which ends a month negative before June:
  //   academia      0      (12000−12000) + (12000−12000)
  //   mercado       35000  (95000−95000) + (110000−110000) + (120000−85000)
  //   transporte    2000   (9000−9000) + (10000−8000)
  //   comer-fora   −4000   5000−9000
  //   farmacia      6000   6000 assigned, no activity
  //   ifood         2000   0 + 0 + (12000−10000)
  //   saude         50000  50000 assigned, no activity
  //   psiquiatra / diversao / celular 0
  // Itau Cartão (payment): assigned 200000 + funded card spending 68000 in
  // June (Mercado 45000, Transporte 8000, Comer Fora 9000−4000 credit, Ifood
  // 10000) + 78000 in May + 24000 in April − the 100000 payment = 270000.
  it("group roll-up sums its categories — pinned to hand-computed literals", () => {
    expect(groupRollup(b, bm, "grp-mes")).toEqual({
      assigned: 224000, // 12000+120000+0+10000+0+5000+6000+12000+50000+9000
      activity: -133000, // −12000−85000−8000−9000−10000−9000
      available: 91000, // Σ of the per-category values above
    });
    // The credit-card group's single payment category rolls up like any other:
    // activity = funded 68000 − payments 100000, available = P1's 270000.
    expect(groupRollup(b, bm, "grp-cc-payments")).toEqual({
      assigned: 200000,
      activity: -32000,
      available: 270000,
    });
  });

  it("unified Available — hand-computed per-category pins", () => {
    const avail = (id: string, month: MonthKey = M) => categoryFigures(budgetMonth(b, month), id).available;
    expect(avail("cat-mercado")).toBe(35000);
    expect(avail("cat-transporte")).toBe(2000);
    expect(avail("cat-comer-fora")).toBe(-4000);
    expect(avail("cat-ifood")).toBe(2000);
    expect(avail("cat-farmacia")).toBe(6000);
    expect(avail("cat-saude")).toBe(50000);
    expect(avail("cat-psiquiatra")).toBe(0);
    expect(avail("cat-nubank-payment")).toBe(270000);
    // Month boundary: months before a category's ledger see nothing yet; future
    // months carry everything posted so far.
    expect(avail("cat-mercado", 202604)).toBe(0);
    expect(avail("cat-mercado", 202605)).toBe(0);
    expect(avail("cat-mercado", 202607)).toBe(35000);
  });

  it("assigned figures match the category's own assignment", () => {
    expect(assignedInMonth(byId("cat-mercado"), M)).toBe(categoryFigures(bm, "cat-mercado").assigned);
  });
});

describe("computeBudgetMonth is never given stale activity", () => {
  it("poisoning every category.activity cache changes nothing", () => {
    const seed = createSeedBudget();
    const clean = computeBudgetMonth(seed, M);
    for (const c of seed.categories) c.activity = { [M]: 999_999 };
    expect(computeBudgetMonth(seed, M)).toEqual(clean);
  });
});
