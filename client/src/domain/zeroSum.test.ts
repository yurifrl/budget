/**
 * Test-first suite for the zero-sum engine (docs/budget-engine-spec.md).
 * Organised by spec section; every test name carries its rule id. Every
 * expected number is derived by hand from the spec formulas (arithmetic in the
 * comments). The engine is NOT implemented yet: all engine tests are expected
 * to fail with "computeBudgetMonth: not implemented" until it is.
 *
 * Money is written in reais via R(): R(1000) = 100000 cents.
 */
import { describe, expect, it } from "bun:test";
import {
  computeBudgetMonth,
  type BudgetMonth,
  type CategoryMonth,
  type PaymentMonth,
} from "./zeroSum";
import {
  dateIn,
  monthOf,
  payId,
  scenario,
  truncateBudget,
  type Scenario,
} from "./__fixtures__/zeroSum.fixtures";
import type { Budget, MonthKey } from "./types";

const R = (reais: number): number => Math.round(reais * 100);

const MAR: MonthKey = 202603;
const JUN: MonthKey = 202606;
const JUL: MonthKey = 202607;
const AUG: MonthKey = 202608;
const SEP: MonthKey = 202609;
const d = (m: MonthKey, day = 10): string => dateIn(m, day);

// ---------------------------------------------------------------------------
// Invariants (spec section 5) as helper assertions
// ---------------------------------------------------------------------------

const balanceOf = (b: Budget, id: string): number => {
  const a = b.accounts.find((x) => x.id === id);
  if (!a) throw new Error(`no account ${id}`);
  return a.clearedBalance + a.unclearedBalance;
};

const cashTotal = (b: Budget): number =>
  b.accounts
    .filter((a) => a.onBudget && a.group !== "CREDIT")
    .reduce((s, a) => s + a.clearedBalance + a.unclearedBalance, 0);

/** Σ spending.available + Σ spending.creditOverspend + Σ payment.available. */
const envelopeTotal = (r: BudgetMonth): number =>
  Object.values(r.categories).reduce((s, c) => s + c.available + c.creditOverspend, 0) +
  Object.values(r.payments).reduce((s, p) => s + p.available, 0);

/** I1/I3 only hold when nothing is dated after the viewed month. */
const nothingAfter = (b: Budget, month: MonthKey): boolean =>
  b.transactions.every((t) => monthOf(t.date) <= month) &&
  b.categories.every((c) => Object.keys(c.assigned).every((k) => Number(k) <= month));

/** I1: cash = RTA + Σ available (negatives kept) + Σ creditOverspend + Σ payment.available. */
function assertI1(b: Budget, r: BudgetMonth): void {
  expect(cashTotal(b)).toBe(r.readyToAssign + envelopeTotal(r));
}

/** I2: per card, underfunded = max(0, debt - max(0, payment.available)), debt from the card balance. */
function assertI2(b: Budget, r: BudgetMonth): void {
  for (const p of Object.values(r.payments)) {
    expect(p.debt).toBe(Math.max(0, -balanceOf(b, p.accountId)));
    expect(p.underfunded).toBe(Math.max(0, p.debt - Math.max(0, p.available)));
  }
}

/**
 * I3: moving X between two spending categories in the same month leaves RTA
 * and the envelope total unchanged (a credit-overspent destination shifts the
 * money on to the payment category, which the envelope total includes).
 */
function assertI3(b: Budget, month: MonthKey, from: string, to: string, x: number): void {
  const before = computeBudgetMonth(b, month);
  const moved = structuredClone(b);
  const f = moved.categories.find((c) => c.id === from);
  const t = moved.categories.find((c) => c.id === to);
  if (!f || !t) throw new Error("I3 categories missing");
  f.assigned[month] = (f.assigned[month] ?? 0) - x;
  t.assigned[month] = (t.assigned[month] ?? 0) + x;
  const after = computeBudgetMonth(moved, month);
  expect(after.readyToAssign).toBe(before.readyToAssign);
  expect(envelopeTotal(after)).toBe(envelopeTotal(before));
}

function assertAllInvariants(b: Budget, r: BudgetMonth, month: MonthKey): void {
  assertI1(b, r);
  assertI2(b, r);
  if (b.categories.some((c) => c.id === "Mercado") && b.categories.some((c) => c.id === "Lazer")) {
    assertI3(b, month, "Lazer", "Mercado", R(7));
    assertI3(b, month, "Mercado", "Lazer", R(7));
  }
}

// ---------------------------------------------------------------------------
// Table-style check helper
// ---------------------------------------------------------------------------

interface Expected {
  rta: number;
  cats?: Record<string, Partial<CategoryMonth>>;
  pays?: Record<string, Partial<PaymentMonth>>;
  /** Account working balances (checked before the engine runs: validates fixtures). */
  bal?: Record<string, number>;
  /** Set false for months that have data after them (I1 to I3 do not apply). */
  invariants?: boolean;
}

function check(b: Budget, month: MonthKey, e: Expected): BudgetMonth {
  for (const [id, cents] of Object.entries(e.bal ?? {})) expect(balanceOf(b, id)).toBe(cents);
  const wantInvariants = e.invariants ?? true;
  if (wantInvariants) expect(nothingAfter(b, month)).toBe(true);
  const r = computeBudgetMonth(b, month);
  expect(r.month).toBe(month);
  expect(r.readyToAssign).toBe(e.rta);
  for (const [id, want] of Object.entries(e.cats ?? {})) expect(r.categories[id]).toMatchObject(want);
  for (const [id, want] of Object.entries(e.pays ?? {})) expect(r.payments[id]).toMatchObject(want);
  if (wantInvariants) assertAllInvariants(b, r, month);
  return r;
}

const base = (): Scenario =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["Mercado", "Lazer"] }).startingBalance(
    "Checking",
    R(1000),
    d(JUN, 1),
  );

const PAY = payId("Card");
const zeroCat = {
  assigned: 0,
  activity: 0,
  carryover: 0,
  available: 0,
  cashOverspend: 0,
  creditOverspend: 0,
};

// ---------------------------------------------------------------------------
// Fixture sanity (these pass today: they only look at the built Budget)
// ---------------------------------------------------------------------------

describe("fixtures: builder sanity", () => {
  it("fixture: account balance equals the sum of that account's transactions", () => {
    const b = base()
      .startingBalance("Card", -R(500), d(JUN, 1))
      .spend("Card", "Mercado", R(70), d(JUN, 5))
      .inflow("Checking", null, R(200), d(JUN, 6))
      .build();
    expect(balanceOf(b, "Checking")).toBe(R(1200));
    expect(balanceOf(b, "Card")).toBe(-R(570));
    for (const a of b.accounts) {
      const sum = b.transactions.filter((t) => t.accountId === a.id).reduce((s, t) => s + t.inflow - t.outflow, 0);
      expect(a.clearedBalance).toBe(sum);
      expect(a.unclearedBalance).toBe(0);
    }
  });

  it("fixture: transfer creates both mirrored legs with transferAccountId and no category", () => {
    const b = scenario({ cash: ["Checking", "Savings"], cards: ["Card"] })
      .transfer("Checking", "Savings", R(200), d(JUN, 3))
      .transfer("Checking", "Card", R(50), d(JUN, 4))
      .build();
    expect(b.transactions).toHaveLength(4);
    const [out, inn] = b.transactions;
    expect(out).toMatchObject({ accountId: "Checking", outflow: R(200), inflow: 0, transferAccountId: "Savings", categoryId: null });
    expect(inn).toMatchObject({ accountId: "Savings", outflow: 0, inflow: R(200), transferAccountId: "Checking", categoryId: null });
    expect(balanceOf(b, "Checking")).toBe(-R(250));
    expect(balanceOf(b, "Savings")).toBe(R(200));
    expect(balanceOf(b, "Card")).toBe(R(50));
  });

  it("fixture: cards get a payment category named like the card, in the flagged group; activity stays empty", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa", "Master"], categories: ["Mercado"] }).build();
    const group = b.groups.find((g) => g.isCreditCardPayments === true);
    expect(group?.categoryIds).toEqual([payId("Visa"), payId("Master")]);
    for (const c of b.categories) {
      expect(c.activity).toEqual({});
    }
    expect(b.categories.find((c) => c.id === payId("Visa"))?.name).toBe("Visa");
    expect(b.accounts.find((a) => a.id === "Visa")).toMatchObject({ type: "credit", group: "CREDIT", onBudget: true });
  });

  it("fixture: upcoming rows are excluded from balances; splits keep a null parent category", () => {
    const b = base()
      .spend("Checking", null, R(100), d(JUN, 2), { upcoming: true })
      .split("Checking", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: null, cents: -R(40) }], d(JUN, 3))
      .build();
    expect(balanceOf(b, "Checking")).toBe(R(900));
    const sp = b.transactions.find((t) => t.splits);
    expect(sp).toMatchObject({ categoryId: null, outflow: R(100) });
    expect(sp?.splits).toHaveLength(2);
  });

  it("fixture: assign accumulates and months cover transactions and assignments", () => {
    const b = base().assign("Mercado", JUL, R(10)).assign("Mercado", JUL, R(5)).assign(payId("Card"), AUG, R(1)).build();
    expect(b.categories.find((c) => c.id === "Mercado")?.assigned).toEqual({ [JUL]: R(15) });
    expect(b.months).toEqual([JUN, JUL, AUG]);
  });
});

// ---------------------------------------------------------------------------
// Section 6: golden scenarios
// ---------------------------------------------------------------------------

describe("G1 worked example", () => {
  it("G1: every step of the table", () => {
    const s = base();

    // Step 0: checking 1000 via Starting Balance: RTA 1000 (R4), nothing else.
    check(s.build(), JUN, {
      rta: R(1000),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: 0, underfunded: 0 } },
      bal: { Checking: R(1000), Card: 0 },
    });

    // Step 1: assign 100 to Mercado: RTA 1000-100 = 900; Mercado 0+100 = 100.
    s.assign("Mercado", JUN, R(100));
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), available: R(100) } },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: 0, underfunded: 0 } },
      bal: { Checking: R(1000), Card: 0 },
    });

    // Step 2: card purchase 70: available 100-70 = 30 >= 0 so funded 70; payment 0+70 = 70; debt 70, underfunded 70-70 = 0.
    s.spend("Card", "Mercado", R(70), d(JUN, 10));
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(70), available: R(30) } },
      pays: { [PAY]: { assigned: 0, funded: R(70), payments: 0, available: R(70), debt: R(70), underfunded: 0 } },
      bal: { Checking: R(1000), Card: -R(70) },
    });

    // Step 3: card purchase 80: available 100-150 = -50; overspend 50; cardSpend 150;
    // credit = min(50,150) = 50; cash = 0; funded = 150-50 = 100; payment 100; debt 150; underfunded 150-100 = 50.
    s.spend("Card", "Mercado", R(80), d(JUN, 12));
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(150), available: -R(50), creditOverspend: R(50) } },
      pays: { [PAY]: { assigned: 0, funded: R(100), payments: 0, available: R(100), debt: R(150), underfunded: R(50) } },
      bal: { Checking: R(1000), Card: -R(150) },
    });

    // Step 4: JUL rollover. Mercado carryover = max(0,-50) = 0, available 0; credit overspend is NOT
    // taken from RTA (900); payment 100+0+0-0 = 100 (P1); debt 150; underfunded 50.
    check(s.build(), JUL, {
      rta: R(900),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: R(100), debt: R(150), underfunded: R(50) } },
      bal: { Checking: R(1000), Card: -R(150) },
    });

    // Step 5: assign 50 to the payment category in JUL: RTA 900-50 = 850; available 100+50 = 150; underfunded 150-150 = 0.
    s.assign(PAY, JUL, R(50));
    check(s.build(), JUL, {
      rta: R(850),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: R(50), funded: 0, payments: 0, available: R(150), debt: R(150), underfunded: 0 } },
      bal: { Checking: R(1000), Card: -R(150) },
    });

    // Step 6: pay 150 (transfer): payments 150; available 150-150 = 0; checking 850; card 0; debt 0. RTA stays 850.
    s.transfer("Checking", "Card", R(150), d(JUL, 15));
    check(s.build(), JUL, {
      rta: R(850),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: R(50), funded: 0, payments: R(150), available: 0, debt: 0, underfunded: 0 } },
      bal: { Checking: R(850), Card: 0 },
    });
  });
});

describe("G2 fresh start with debt", () => {
  it("G2: debt gets nothing until assigned", () => {
    const s = base().startingBalance("Checking", R(5731.69), d(JUN, 1)); // 1000 + 5731.69 = 6731.69
    s.startingBalance("Card", -R(12137.96), d(JUN, 1));
    // RTA = 6731.69; payment available 0; debt 12137.96; underfunded 12137.96-0.
    check(s.build(), JUN, {
      rta: R(6731.69),
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: R(12137.96), underfunded: R(12137.96) } },
      bal: { Checking: R(6731.69), Card: -R(12137.96) },
    });
    // Assign 6731.69: RTA 0; available 6731.69; underfunded 12137.96-6731.69 = 5406.27.
    s.assign(PAY, JUN, R(6731.69));
    check(s.build(), JUN, {
      rta: 0,
      pays: { [PAY]: { assigned: R(6731.69), funded: 0, payments: 0, available: R(6731.69), debt: R(12137.96), underfunded: R(5406.27) } },
    });
  });
});

describe("G3 cash overspend", () => {
  it("G3: category -50 cash, RTA 900 then 850, category 0 next month", () => {
    const s = scenario({ cash: ["Checking"], categories: ["Mercado", "Lazer"] })
      .startingBalance("Checking", R(1000), d(JUN, 1))
      .assign("Mercado", JUN, R(100))
      .spend("Checking", "Mercado", R(150), d(JUN, 8));
    // JUN: RTA 1000-100 = 900; Mercado 100-150 = -50, cardSpend 0 so credit 0, cash 50. Checking 850.
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(150), available: -R(50), cashOverspend: R(50) } },
      bal: { Checking: R(850) },
    });
    // JUL: RTA 900-50 = 850 (S4); Mercado carries 0.
    check(s.build(), JUL, { rta: R(850), cats: { Mercado: zeroCat }, bal: { Checking: R(850) } });
  });
});

describe("G4 mixed overspend", () => {
  it("G4: available -70, credit 50, cash 20, funded 0; next month RTA drops by 20 only", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Checking", "Mercado", R(120), d(JUN, 5))
      .spend("Card", "Mercado", R(50), d(JUN, 6));
    // JUN: avail 100-120-50 = -70; overspend 70; cardSpend 50; credit min(70,50) = 50; cash 70-50 = 20;
    // funded 50-50 = 0. RTA 1000-100 = 900. Checking 880. Card debt 50, underfunded 50-0.
    check(s.build(), JUN, {
      rta: R(900),
      cats: {
        Mercado: { ...zeroCat, assigned: R(100), activity: -R(170), available: -R(70), cashOverspend: R(20), creditOverspend: R(50) },
      },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: R(50), underfunded: R(50) } },
      bal: { Checking: R(880), Card: -R(50) },
    });
    // JUL: RTA 900-20 = 880 (credit part not subtracted); Mercado 0; payment still 0.
    check(s.build(), JUL, {
      rta: R(880),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: R(50), underfunded: R(50) } },
    });
  });
});

describe("G5 cover in month", () => {
  it("G5: G1 step 3, then 50 more to Mercado in the same month", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Card", "Mercado", R(70), d(JUN, 10))
      .spend("Card", "Mercado", R(80), d(JUN, 12))
      .assign("Mercado", JUN, R(50));
    // Mercado assigned 150, avail 150-150 = 0, no overspend, funded 150 (all card spend). RTA 1000-150 = 850.
    // Payment available 150; debt 150; underfunded 0.
    check(s.build(), JUN, {
      rta: R(850),
      cats: { Mercado: { ...zeroCat, assigned: R(150), activity: -R(150) } },
      pays: { [PAY]: { assigned: 0, funded: R(150), payments: 0, available: R(150), debt: R(150), underfunded: 0 } },
      bal: { Checking: R(1000), Card: -R(150) },
    });
  });
});

describe("G6 regression: card overspend is not charged to RTA", () => {
  it("G6: 50 assigned, 90 on the card: RTA next month not reduced by 40, payment 50, underfunded 40", () => {
    const s = base().assign("Mercado", JUN, R(50)).spend("Card", "Mercado", R(90), d(JUN, 9));
    // JUN: avail 50-90 = -40; credit min(40,90) = 40; cash 0; funded 90-40 = 50; payment 50; debt 90; underfunded 90-50 = 40. RTA 950.
    check(s.build(), JUN, {
      rta: R(950),
      cats: { Mercado: { ...zeroCat, assigned: R(50), activity: -R(90), available: -R(40), creditOverspend: R(40) } },
      pays: { [PAY]: { assigned: 0, funded: R(50), payments: 0, available: R(50), debt: R(90), underfunded: R(40) } },
    });
    // JUL: RTA stays 950 (NOT 910); Mercado 0; payment 50; underfunded 40.
    check(s.build(), JUL, {
      rta: R(950),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: R(50), debt: R(90), underfunded: R(40) } },
    });
  });
});

describe("G7 regression: earlier payment assignments carry (P1)", () => {
  it("G7: assigned in JUN still counts in JUL and AUG", () => {
    const s = base().startingBalance("Card", -R(300), d(JUN, 1)).assign(PAY, JUN, R(100));
    // JUN: RTA 900; available 100; debt 300; underfunded 200.
    check(s.build(), JUN, {
      rta: R(900),
      pays: { [PAY]: { assigned: R(100), funded: 0, payments: 0, available: R(100), debt: R(300), underfunded: R(200) } },
    });
    // AUG with nothing in between: assigned this month 0, available still 100+0 = 100, RTA 900.
    check(s.build(), AUG, {
      rta: R(900),
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: R(100), debt: R(300), underfunded: R(200) } },
    });
    // Add JUL: assign 40 Mercado, spend 40 on the card (funded 40). Card -340. RTA 900-40 = 860.
    s.assign("Mercado", JUL, R(40)).spend("Card", "Mercado", R(40), d(JUL, 3));
    // JUL: payment 100+40 = 140; debt 340; underfunded 200.
    check(s.build(), JUL, {
      rta: R(860),
      cats: { Mercado: { ...zeroCat, assigned: R(40), activity: -R(40) } },
      pays: { [PAY]: { assigned: 0, funded: R(40), payments: 0, available: R(140), debt: R(340), underfunded: R(200) } },
    });
    // AUG: payment still 140, RTA 860.
    check(s.build(), AUG, {
      rta: R(860),
      cats: { Mercado: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: R(140), debt: R(340), underfunded: R(200) } },
    });
  });
});

describe("G8 statement credit", () => {
  it("G8: uncategorized card inflow 30 with debt 100 and available 100", () => {
    const s = base().startingBalance("Card", -R(100), d(JUN, 1)).assign(PAY, JUN, R(100));
    check(s.build(), JUN, {
      rta: R(900),
      pays: { [PAY]: { assigned: R(100), funded: 0, payments: 0, available: R(100), debt: R(100), underfunded: 0 } },
    });
    s.inflow("Card", null, R(30), d(JUN, 20));
    // R5: no budget effect: RTA 900, available 100; debt 100-30 = 70; underfunded max(0,70-100) = 0.
    check(s.build(), JUN, {
      rta: R(900),
      pays: { [PAY]: { assigned: R(100), funded: 0, payments: 0, available: R(100), debt: R(70), underfunded: 0 } },
      bal: { Card: -R(70) },
    });
  });
});

// ---------------------------------------------------------------------------
// Section 1: Ready to Assign
// ---------------------------------------------------------------------------

describe("section 1: RTA", () => {
  it("R1: card debt never increases RTA", () => {
    const s = base().startingBalance("Card", -R(500), d(JUN, 1));
    // RTA = 1000 (not 1500 or 500).
    check(s.build(), JUN, { rta: R(1000) });
    // Uncategorized card purchase 200: still 1000.
    s.spend("Card", null, R(200), d(JUN, 4));
    check(s.build(), JUN, { rta: R(1000) });
    // Categorized card purchase 100 with nothing assigned: credit overspend 100, RTA still 1000.
    s.spend("Card", "Mercado", R(100), d(JUN, 5));
    check(s.build(), JUN, {
      rta: R(1000),
      cats: { Mercado: { ...zeroCat, activity: -R(100), available: -R(100), creditOverspend: R(100) } },
      // card -800: debt 800; available 0 (funded = 100-100 = 0); underfunded 800
      pays: { [PAY]: { funded: 0, available: 0, debt: R(800), underfunded: R(800) } },
    });
  });

  it("R2: assigning to a category or a payment category lowers RTA; un-assigning raises it", () => {
    const s = base().assign("Mercado", JUN, R(300)).assign(PAY, JUN, R(200));
    // RTA 1000-300-200 = 500.
    check(s.build(), JUN, {
      rta: R(500),
      cats: { Mercado: { ...zeroCat, assigned: R(300), available: R(300) } },
      pays: { [PAY]: { assigned: R(200), available: R(200), debt: 0, underfunded: 0 } },
    });
    // Un-assign 100 from Mercado: RTA 500+100 = 600; Mercado 200.
    s.assign("Mercado", JUN, -R(100));
    check(s.build(), JUN, { rta: R(600), cats: { Mercado: { ...zeroCat, assigned: R(200), available: R(200) } } });
  });

  it("R3: assignments in later months lower the viewed month's RTA immediately", () => {
    const s = base().assign("Mercado", JUL, R(200)).assign(PAY, AUG, R(100));
    // 1000-200-100 = 700 in every month.
    check(s.build(), JUN, { rta: R(700), cats: { Mercado: zeroCat }, pays: { [PAY]: { assigned: 0, available: 0 } }, invariants: false });
    check(s.build(), JUL, {
      rta: R(700),
      cats: { Mercado: { ...zeroCat, assigned: R(200), available: R(200) } },
      pays: { [PAY]: { assigned: 0, available: 0 } },
      invariants: false,
    });
    check(s.build(), AUG, { rta: R(700), pays: { [PAY]: { assigned: R(100), available: R(100) } } });
    check(s.build(), SEP, { rta: R(700) });
  });

  it("R4: uncategorized non-transfer cash transactions hit RTA in the month they occur", () => {
    const s = base().inflow("Checking", null, R(500), d(JUL, 5)).spend("Checking", null, R(200), d(JUL, 20));
    // JUN: 1000 (JUL rows not yet). JUL: 1000+500-200 = 1300.
    check(s.build(), JUN, { rta: R(1000), invariants: false });
    check(s.build(), JUL, { rta: R(1300), bal: { Checking: R(1300) } });
  });

  it("R5: uncategorized card transactions have no budget effect", () => {
    const s = base().startingBalance("Card", -R(300), d(JUN, 1)).spend("Card", null, R(100), d(JUN, 3));
    // Card -400. RTA 1000, funded 0, available 0, debt 400, underfunded 400.
    check(s.build(), JUN, {
      rta: R(1000),
      pays: { [PAY]: { funded: 0, payments: 0, available: 0, debt: R(400), underfunded: R(400) } },
    });
    // Statement credit 150: card -250: RTA 1000, available 0, debt 250, underfunded 250.
    s.inflow("Card", null, R(150), d(JUN, 9));
    check(s.build(), JUN, {
      rta: R(1000),
      pays: { [PAY]: { funded: 0, payments: 0, available: 0, debt: R(250), underfunded: R(250) } },
      bal: { Card: -R(250) },
    });
  });
});

// ---------------------------------------------------------------------------
// Section 2: spending categories
// ---------------------------------------------------------------------------

describe("section 2: spending categories", () => {
  it("S1: funded card spending moves to each card's payment category", () => {
    const s = scenario({ cash: ["Checking"], cards: ["CardA", "CardB"], categories: ["Mercado", "Lazer"] })
      .startingBalance("Checking", R(1000), d(JUN, 1))
      .assign("Mercado", JUN, R(300))
      .spend("CardA", "Mercado", R(100), d(JUN, 4))
      .spend("CardB", "Mercado", R(50), d(JUN, 5));
    // avail 300-150 = 150 >= 0: A funded 100, B funded 50. RTA 700.
    check(s.build(), JUN, {
      rta: R(700),
      cats: { Mercado: { ...zeroCat, assigned: R(300), activity: -R(150), available: R(150) } },
      pays: {
        [payId("CardA")]: { funded: R(100), available: R(100), debt: R(100), underfunded: 0 },
        [payId("CardB")]: { funded: R(50), available: R(50), debt: R(50), underfunded: 0 },
      },
    });
  });

  it("S2: credit overspending takes what is left; exact zero is not overspending", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .assign("Lazer", JUN, R(100))
      .spend("Card", "Mercado", R(150), d(JUN, 4))
      .spend("Card", "Lazer", R(100), d(JUN, 5));
    // Mercado: 100-150 = -50, credit 50, cash 0, funded 100. Lazer: 100-100 = 0, funded 100.
    // Payment 200; debt 250; underfunded 50. RTA 1000-200 = 800.
    check(s.build(), JUN, {
      rta: R(800),
      cats: {
        Mercado: { ...zeroCat, assigned: R(100), activity: -R(150), available: -R(50), creditOverspend: R(50) },
        Lazer: { ...zeroCat, assigned: R(100), activity: -R(100) },
      },
      pays: { [PAY]: { funded: R(200), available: R(200), debt: R(250), underfunded: R(50) } },
    });
  });

  it("S3: money added later in the month flows on to the payment category (end-of-month computation)", () => {
    const s = base().assign("Mercado", JUN, R(40)).spend("Card", "Mercado", R(100), d(JUN, 5));
    // avail 40-100 = -60; credit 60; funded 100-60 = 40. RTA 960.
    check(s.build(), JUN, {
      rta: R(960),
      cats: { Mercado: { ...zeroCat, assigned: R(40), activity: -R(100), available: -R(60), creditOverspend: R(60) } },
      pays: { [PAY]: { funded: R(40), available: R(40), debt: R(100), underfunded: R(60) } },
    });
    // +60 later in the month: avail 0, funded 100, payment 100. RTA 900.
    s.assign("Mercado", JUN, R(60));
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(100) } },
      pays: { [PAY]: { funded: R(100), available: R(100), debt: R(100), underfunded: 0 } },
    });
  });

  it("S4: cash overspend is charged to next month's RTA; credit overspend is not; both carry 0", () => {
    const s = base()
      .assign("Mercado", JUN, R(50))
      .assign("Lazer", JUN, R(10))
      .spend("Checking", "Mercado", R(80), d(JUN, 5))
      .spend("Card", "Lazer", R(30), d(JUN, 6));
    // Mercado: 50-80 = -30, cardSpend 0 so cash 30. Lazer: 10-30 = -20, cardSpend 30, credit 20, cash 0, funded 10.
    // JUN RTA 1000-60 = 940. Checking 920. Payment 10; debt 30; underfunded 20.
    check(s.build(), JUN, {
      rta: R(940),
      cats: {
        Mercado: { ...zeroCat, assigned: R(50), activity: -R(80), available: -R(30), cashOverspend: R(30) },
        Lazer: { ...zeroCat, assigned: R(10), activity: -R(30), available: -R(20), creditOverspend: R(20) },
      },
      pays: { [PAY]: { funded: R(10), available: R(10), debt: R(30), underfunded: R(20) } },
      bal: { Checking: R(920), Card: -R(30) },
    });
    // JUL RTA 940-30 = 910 (only the cash 30). Both categories carry 0. Payment 10, underfunded 20.
    check(s.build(), JUL, {
      rta: R(910),
      cats: { Mercado: zeroCat, Lazer: zeroCat },
      pays: { [PAY]: { funded: 0, available: R(10), debt: R(30), underfunded: R(20) } },
    });
  });

  it("S4: positive Available carries over in full", () => {
    const s = base().assign("Mercado", JUN, R(100)).spend("Checking", "Mercado", R(30), d(JUN, 5)).assign("Mercado", JUL, R(20));
    // JUN avail 70; JUL carryover 70, start 90, avail 90. RTA JUL 1000-100-20 = 880 (cash spend categorized).
    check(s.build(), JUL, { rta: R(880), cats: { Mercado: { ...zeroCat, assigned: R(20), carryover: R(70), available: R(90) } } });
  });

  it("S5: any cash overspend is cash-overspent; credit-only is credit-overspent", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Checking", "Mercado", R(120), d(JUN, 5))
      .spend("Card", "Mercado", R(50), d(JUN, 6)) // mixed: cash 20 + credit 50
      .assign("Lazer", JUN, R(10))
      .spend("Card", "Lazer", R(30), d(JUN, 7)); // credit only: 20
    const r = computeBudgetMonth(s.build(), JUN);
    // Mercado: cash 20 > 0 so it is cash-overspent (red) even though it also has credit 50.
    expect(r.categories.Mercado.cashOverspend).toBe(R(20));
    expect(r.categories.Mercado.creditOverspend).toBe(R(50));
    // Lazer: 10-30 = -20, credit 20, cash 0 so credit-overspent (yellow) only.
    expect(r.categories.Lazer.cashOverspend).toBe(0);
    expect(r.categories.Lazer.creditOverspend).toBe(R(20));
  });

  it("S6: a card refund nets against that month's card spending", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Card", "Mercado", R(70), d(JUN, 10))
      .inflow("Card", "Mercado", R(30), d(JUN, 12));
    // cardNet -70+30 = -40; avail 100-40 = 60; funded 40; payment 40; card -40; underfunded 0.
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(40), available: R(60) } },
      pays: { [PAY]: { funded: R(40), available: R(40), debt: R(40), underfunded: 0 } },
      bal: { Card: -R(40) },
    });
  });

  it("S6: a month with net positive cardNet moves that amount back OUT of the payment category", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Card", "Mercado", R(70), d(JUN, 10))
      .inflow("Card", "Mercado", R(30), d(JUL, 15));
    // JUN: avail 30, funded 70, payment 70.
    // JUL: carryover 30, cardNet +30, avail 60; funded -30; payment 70-30 = 40; card -40; underfunded 0. RTA 900.
    check(s.build(), JUL, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, carryover: R(30), activity: R(30), available: R(60) } },
      pays: { [PAY]: { assigned: 0, funded: -R(30), payments: 0, available: R(40), debt: R(40), underfunded: 0 } },
    });
  });

  describe("S7 multi-card credit overspending split", () => {
    const two = (): Scenario =>
      scenario({ cash: ["Checking"], cards: ["CardA", "CardB"], categories: ["Mercado", "Lazer"] }).startingBalance(
        "Checking",
        R(1000),
        d(JUN, 1),
      );

    it("S7: proportional split without remainder", () => {
      const s = two().assign("Mercado", JUN, R(30)).spend("CardA", "Mercado", R(100), d(JUN, 3)).spend("CardB", "Mercado", R(50), d(JUN, 4));
      // avail 30-150 = -120; credit 120. Shares: A 120*100/150 = 80, B 120*50/150 = 40 (exact).
      // funded A 100-80 = 20, B 50-40 = 10 (sum 30 = assigned). RTA 970.
      check(s.build(), JUN, {
        rta: R(970),
        cats: { Mercado: { ...zeroCat, assigned: R(30), activity: -R(150), available: -R(120), creditOverspend: R(120) } },
        pays: {
          [payId("CardA")]: { funded: R(20), available: R(20), debt: R(100), underfunded: R(80) },
          [payId("CardB")]: { funded: R(10), available: R(10), debt: R(50), underfunded: R(40) },
        },
      });
    });

    it("S7: leftover cent goes to the largest net spend; ties go to the lowest account id", () => {
      const s = two().assign("Mercado", JUN, R(0.99)).spend("CardA", "Mercado", R(1), d(JUN, 3)).spend("CardB", "Mercado", R(1), d(JUN, 4));
      // assigned 99c; spends 100c + 100c; avail 99-200 = -101; credit 101.
      // floor shares: 101*100/200 = 50 each (50.5), leftover 1 -> tie, lowest id CardA: credit A 51, B 50.
      // funded A 100-51 = 49, B 100-50 = 50 (sum 99).
      check(s.build(), JUN, {
        rta: R(1000) - 99,
        cats: { Mercado: { ...zeroCat, assigned: 99, activity: -200, available: -101, creditOverspend: 101 } },
        pays: {
          [payId("CardA")]: { funded: 49, available: 49 },
          [payId("CardB")]: { funded: 50, available: 50 },
        },
      });
    });

    it("S7: leftover goes to the card with the largest net spend (unequal spends)", () => {
      const s = two().assign("Mercado", JUN, R(1)).spend("CardA", "Mercado", R(1), d(JUN, 3)).spend("CardB", "Mercado", R(2), d(JUN, 4));
      // assigned 100c; spends A 100c, B 200c; avail 100-300 = -200; credit 200.
      // floor shares: A 200*100/300 = 66 (66.67), B 200*200/300 = 133 (133.33); leftover 1 -> largest spend B: B 134, A 66.
      // funded A 100-66 = 34, B 200-134 = 66 (sum 100).
      check(s.build(), JUN, {
        rta: R(1000) - 100,
        cats: { Mercado: { ...zeroCat, assigned: 100, activity: -300, available: -200, creditOverspend: 200 } },
        pays: {
          [payId("CardA")]: { funded: 34, available: 34 },
          [payId("CardB")]: { funded: 66, available: 66 },
        },
      });
    });

    it("S6+S7: overspent category, net refund on card A and net spend on card B", () => {
      const s = two().assign("Mercado", JUN, R(50)).inflow("CardA", "Mercado", R(30), d(JUN, 3)).spend("CardB", "Mercado", R(100), d(JUN, 4));
      // cardNet A +30, B -100; avail 50+30-100 = -20; cardSpend = max(0,-30)+max(0,100) = 100 (A excluded);
      // credit min(20,100) = 20; cash 0. Split only among cards with net spend: all 20 to B. funded B 100-20 = 80.
      // A has a net refund so funded A = -30 (S6/S2) even though overspent: A available 0-30 = -30 (cash overspend, P5).
      // RTA 1000-50 = 950. Cash 1000 = 950 + (-20+20) + (-30+80). Debts: A balance +30 -> 0; B 100.
      // underfunded: A max(0, 0-max(0,-30)) = 0 (negative Available is overspending); B 100-80 = 20.
      check(s.build(), JUN, {
        rta: R(950),
        cats: { Mercado: { ...zeroCat, assigned: R(50), activity: -R(70), available: -R(20), creditOverspend: R(20) } },
        pays: {
          [payId("CardA")]: { assigned: 0, funded: -R(30), payments: 0, available: -R(30), debt: 0, underfunded: 0 },
          [payId("CardB")]: { assigned: 0, funded: R(80), payments: 0, available: R(80), debt: R(100), underfunded: R(20) },
        },
        bal: { CardA: R(30), CardB: -R(100) },
      });
      // JUL: A's negative Available is cash overspending: RTA 950-30 = 920, A carries 0; B keeps 80.
      check(s.build(), JUL, {
        rta: R(920),
        cats: { Mercado: zeroCat },
        pays: {
          [payId("CardA")]: { funded: 0, available: 0, debt: 0, underfunded: 0 },
          [payId("CardB")]: { funded: 0, available: R(80), debt: R(100), underfunded: R(20) },
        },
      });
    });
  });

  it("S2/S6: overspent category with only a card refund: the refund still leaves the payment category", () => {
    const s = base().spend("Checking", "Mercado", R(100), d(JUN, 3)).inflow("Card", "Mercado", R(30), d(JUN, 4));
    // avail 0-100+30 = -70; cardSpend 0 -> credit 0, cash 70. Card has a net refund: funded -30.
    // Payment 0-30 = -30 (cash overspending). RTA 1000. Cash 900 = 1000 + (-70) + (-30).
    check(s.build(), JUN, {
      rta: R(1000),
      cats: { Mercado: { ...zeroCat, activity: -R(70), available: -R(70), cashOverspend: R(70) } },
      pays: { [PAY]: { funded: -R(30), payments: 0, available: -R(30), debt: 0, underfunded: 0 } },
      bal: { Checking: R(900), Card: R(30) },
    });
    // JUL: RTA 1000-70-30 = 900; everything carries 0.
    check(s.build(), JUL, { rta: R(900), cats: { Mercado: zeroCat }, pays: { [PAY]: { funded: 0, available: 0 } } });
  });
});

// ---------------------------------------------------------------------------
// Section 3: card payment categories
// ---------------------------------------------------------------------------

describe("section 3: card payment categories", () => {
  it("P1: carried envelope, cumulative assigned + funded - payments, independent of the card balance", () => {
    const s = base().startingBalance("Card", -R(300), d(JUN, 1)).assign(PAY, JUN, R(100)).assign(PAY, JUL, R(50)).assign(PAY, AUG, R(25));
    // No spending: 100, 150, 175 cumulative; RTA 1000-175 = 825 everywhere (R3).
    check(s.build(), JUN, { rta: R(825), pays: { [PAY]: { assigned: R(100), available: R(100) } }, invariants: false });
    check(s.build(), JUL, { rta: R(825), pays: { [PAY]: { assigned: R(50), available: R(150) } }, invariants: false });
    check(s.build(), AUG, {
      rta: R(825),
      pays: { [PAY]: { assigned: R(25), funded: 0, payments: 0, available: R(175), debt: R(300), underfunded: R(125) } },
    });
    // Funded spending adds to the same cumulative figure: JUL assign 40 Mercado, spend 40 on card.
    // JUL 100+50+40 = 190; AUG 190+25 = 215. RTA 1000-175-40 = 785. Card -340: underfunded AUG 340-215 = 125.
    s.assign("Mercado", JUL, R(40)).spend("Card", "Mercado", R(40), d(JUL, 6));
    check(s.build(), JUL, { rta: R(785), pays: { [PAY]: { assigned: R(50), funded: R(40), available: R(190) } }, invariants: false });
    check(s.build(), AUG, {
      rta: R(785),
      pays: { [PAY]: { assigned: R(25), funded: 0, available: R(215), debt: R(340), underfunded: R(125) } },
    });
  });

  it("P2: a payment lowers Available; a card-to-cash transfer raises it", () => {
    const s = base().startingBalance("Card", -R(200), d(JUN, 1)).assign(PAY, JUN, R(200));
    check(s.build(), JUN, { rta: R(800), pays: { [PAY]: { available: R(200), debt: R(200), underfunded: 0 } } });
    // Pay 80: payments 80, available 120, card -120, checking 920. RTA unchanged 800.
    s.transfer("Checking", "Card", R(80), d(JUN, 20));
    check(s.build(), JUN, {
      rta: R(800),
      pays: { [PAY]: { assigned: R(200), funded: 0, payments: R(80), available: R(120), debt: R(120), underfunded: 0 } },
      bal: { Checking: R(920), Card: -R(120) },
    });
    // Cash advance 30 (card -> checking): net payments 80-30 = 50, available 200-50 = 150, card -150, checking 950.
    s.transfer("Card", "Checking", R(30), d(JUN, 22));
    check(s.build(), JUN, {
      rta: R(800),
      pays: { [PAY]: { payments: R(50), available: R(150), debt: R(150), underfunded: 0 } },
      bal: { Checking: R(950), Card: -R(150) },
    });
  });

  it("P3: starting debt gets nothing automatically, in any month", () => {
    const s = base().startingBalance("Card", -R(500), d(JUN, 1));
    check(s.build(), JUN, { rta: R(1000), pays: { [PAY]: { funded: 0, available: 0, debt: R(500), underfunded: R(500) } } });
    check(s.build(), AUG, { rta: R(1000), pays: { [PAY]: { funded: 0, available: 0, debt: R(500), underfunded: R(500) } } });
  });

  it("P4: underfunded = max(0, debt - max(0, available))", () => {
    // A: debt 100, available 150 -> 0.
    const a = base().startingBalance("Card", -R(100), d(JUN, 1)).assign(PAY, JUN, R(150));
    check(a.build(), JUN, { rta: R(850), pays: { [PAY]: { available: R(150), debt: R(100), underfunded: 0 } } });
    // B: debt 100, available 30 -> 70.
    const b = base().startingBalance("Card", -R(100), d(JUN, 1)).assign(PAY, JUN, R(30));
    check(b.build(), JUN, { rta: R(970), pays: { [PAY]: { available: R(30), debt: R(100), underfunded: R(70) } } });
    // C: positive card balance +50 (uncategorized inflow): debt max(0,-50) = 0, underfunded 0, no budget effect.
    const c = base().inflow("Card", null, R(50), d(JUN, 1));
    check(c.build(), JUN, { rta: R(1000), pays: { [PAY]: { available: 0, debt: 0, underfunded: 0 } }, bal: { Card: R(50) } });
  });

  it("P5: paying more than Available leaves it negative; next month's RTA pays for it, then it carries 0", () => {
    const s = base().startingBalance("Card", -R(200), d(JUN, 1)).assign(PAY, JUN, R(50)).transfer("Checking", "Card", R(120), d(JUN, 15));
    // JUN: available 50-120 = -70; card -80, debt 80; underfunded max(0, 80-max(0,-70)) = 80 (negative Available is overspending, not extra underfunding).
    // RTA 1000-50 = 950; checking 880. I1: 880 = 950 + (-70).
    check(s.build(), JUN, {
      rta: R(950),
      pays: { [PAY]: { assigned: R(50), funded: 0, payments: R(120), available: -R(70), debt: R(80), underfunded: R(80) } },
      bal: { Checking: R(880), Card: -R(80) },
    });
    // JUL: RTA 950-70 = 880; available carries 0; debt 80; underfunded 80.
    check(s.build(), JUL, {
      rta: R(880),
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: R(80), underfunded: R(80) } },
    });
    // P1 recursion: assigning 30 in JUL gives max(0,-70)+30 = 30 (not -70+30 = -40). RTA 880-30 = 850.
    s.assign(PAY, JUL, R(30));
    check(s.build(), JUL, {
      rta: R(850),
      pays: { [PAY]: { assigned: R(30), funded: 0, payments: 0, available: R(30), debt: R(80), underfunded: R(50) } },
    });
  });

  it("P6: card-to-card balance transfers move nothing between payment categories", () => {
    const s = scenario({ cash: ["Checking"], cards: ["CardA", "CardB"], categories: ["Mercado"] })
      .startingBalance("Checking", R(1000), d(JUN, 1))
      .startingBalance("CardA", -R(300), d(JUN, 1))
      .assign(payId("CardA"), JUN, R(300))
      .transfer("CardB", "CardA", R(100), d(JUN, 15));
    // CardB -100, CardA -200. Payments unchanged: A avail 300 (underfunded 0), B avail 0 (debt 100, underfunded 100). RTA 700.
    check(s.build(), JUN, {
      rta: R(700),
      pays: {
        [payId("CardA")]: { assigned: R(300), funded: 0, payments: 0, available: R(300), debt: R(200), underfunded: 0 },
        [payId("CardB")]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: R(100), underfunded: R(100) },
      },
      bal: { CardA: -R(200), CardB: -R(100) },
    });
  });

  describe("P7: spending absorbed by a positive card balance moves nothing", () => {
    it("worked example: +100 from an overpayment, assign 200, spend 150 -> only the 50 of new debt moves", () => {
      const s = base().transfer("Checking", "Card", R(100), d(JUN, 5)); // overpayment: card +100, payment Available -100 (P5)
      check(s.build(), JUN, {
        rta: R(1000),
        pays: { [PAY]: { available: -R(100), debt: 0, underfunded: 0 } },
        bal: { Checking: R(900), Card: R(100) },
      });
      s.assign("Mercado", JUL, R(200)).spend("Card", "Mercado", R(150), d(JUL, 10));
      // JUL: balance 100-150 = -50 -> debt 50; Mercado 200-150 = 50; funded 50 (not 150).
      // The overpayment hole is swept from RTA (900); the other 100 of Mercado's money returns to RTA:
      // RTA = 900 - 200 + 100 = 800. I1: 900 = 800 + 50 + 50.
      const r = check(s.build(), JUL, {
        rta: R(800),
        cats: { Mercado: { assigned: R(200), available: R(50), creditOverspend: 0, cashOverspend: 0 } },
        pays: { [PAY]: { funded: R(50), available: R(50), debt: R(50), underfunded: 0 } },
        bal: { Checking: R(900), Card: -R(50) },
      });
      expect(r.payments[PAY].underfunded).toBe(0);
    });

    it("a card that stays positive all month moves nothing; the spent money returns to RTA", () => {
      const s = base().inflow("Card", null, R(100), d(JUN, 1)).assign("Mercado", JUN, R(200)).spend("Card", "Mercado", R(60), d(JUN, 10));
      check(s.build(), JUN, {
        rta: R(860),
        cats: { Mercado: { available: R(140) } },
        pays: { [PAY]: { funded: 0, available: 0, debt: 0, underfunded: 0 } },
        bal: { Checking: R(1000), Card: R(40) },
      });
    });

    it("a card crossing from positive to negative moves only the part below zero", () => {
      const s = base().inflow("Card", null, R(100), d(JUN, 1)).assign("Mercado", JUN, R(200)).spend("Card", "Mercado", R(150), d(JUN, 10));
      check(s.build(), JUN, {
        rta: R(900),
        cats: { Mercado: { available: R(50) } },
        pays: { [PAY]: { funded: R(50), available: R(50), debt: R(50), underfunded: 0 } },
        bal: { Checking: R(1000), Card: -R(50) },
      });
    });

    it("a payment in the same month does not hide the month's spending (payments settle last)", () => {
      const s = base().assign("Mercado", JUN, R(100)).spend("Card", "Mercado", R(70), d(JUN, 5)).transfer("Checking", "Card", R(70), d(JUN, 20));
      check(s.build(), JUN, {
        rta: R(900),
        pays: { [PAY]: { funded: R(70), payments: R(70), available: 0, debt: 0, underfunded: 0 } },
      });
    });
  });
  it("P4/L1: debt for a historical month is the card ledger balance at the END of that month", () => {
    const s = base().assign(PAY, JUN, R(30)).spend("Card", null, R(100), d(JUN, 5)).spend("Card", null, R(50), d(JUL, 5));
    // JUN: ledger -100 only: debt 100; available 30; underfunded 100-30 = 70. RTA 970 (JUL row is uncategorized card: no effect).
    check(s.build(), JUN, {
      rta: R(970),
      pays: { [PAY]: { available: R(30), debt: R(100), underfunded: R(70) } },
      invariants: false,
    });
    // JUL: ledger -150: debt 150; available 30; underfunded 120.
    check(s.build(), JUL, {
      rta: R(970),
      pays: { [PAY]: { available: R(30), debt: R(150), underfunded: R(120) } },
      bal: { Card: -R(150) },
    });
  });
});

// ---------------------------------------------------------------------------
// Section 4: transfers
// ---------------------------------------------------------------------------

describe("section 4: transfers", () => {
  it("T2: cash to cash (both on-budget) has no budget effect", () => {
    const s = scenario({ cash: ["Checking", "Savings"], cards: ["Card"], categories: ["Mercado"] })
      .startingBalance("Checking", R(1000), d(JUN, 1))
      .assign("Mercado", JUN, R(100))
      .transfer("Checking", "Savings", R(200), d(JUN, 3));
    // RTA 900; Mercado 100; balances 800/200.
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), available: R(100) } },
      pays: { [PAY]: { funded: 0, payments: 0, available: 0 } },
      bal: { Checking: R(800), Savings: R(200) },
    });
  });

  it("T3: cash to card is a payment (see P2) and touches no spending category", () => {
    const s = base()
      .startingBalance("Card", -R(60), d(JUN, 1))
      .assign("Mercado", JUN, R(100))
      .assign(PAY, JUN, R(60))
      .transfer("Checking", "Card", R(60), d(JUN, 9));
    // RTA 1000-160 = 840; Mercado 100 untouched; payment 60-60 = 0; card 0; checking 940.
    check(s.build(), JUN, {
      rta: R(840),
      cats: { Mercado: { ...zeroCat, assigned: R(100), available: R(100) } },
      pays: { [PAY]: { assigned: R(60), payments: R(60), available: 0, debt: 0, underfunded: 0 } },
      bal: { Checking: R(940), Card: 0 },
    });
  });

  describe("T4 off-budget accounts", () => {
    const withInvest = (): Scenario =>
      scenario({ cash: ["Checking"], cards: ["Card"], categories: ["Mercado"], offBudget: ["Invest"] }).startingBalance(
        "Checking",
        R(1000),
        d(JUN, 1),
      );

    it("T4: uncategorized transfer to off-budget behaves like an uncategorized outflow (R4)", () => {
      // RTA 1000-100 = 900; checking 900. The off-budget leg is ignored.
      check(withInvest().transfer("Checking", "Invest", R(100), d(JUN, 5)).build(), JUN, {
        rta: R(900),
        bal: { Checking: R(900), Invest: R(100) },
      });
    });

    it("T4: categorized transfer to off-budget is category activity", () => {
      const s = withInvest().assign("Mercado", JUN, R(150)).transfer("Checking", "Invest", R(100), d(JUN, 5), { category: "Mercado" });
      // Mercado 150-100 = 50; RTA 1000-150 = 850.
      check(s.build(), JUN, {
        rta: R(850),
        cats: { Mercado: { ...zeroCat, assigned: R(150), activity: -R(100), available: R(50) } },
      });
    });

    it("T4: uncategorized transfer from off-budget behaves like an uncategorized inflow (R4)", () => {
      // RTA 1000+40 = 1040.
      check(withInvest().transfer("Invest", "Checking", R(40), d(JUN, 5)).build(), JUN, {
        rta: R(1040),
        bal: { Checking: R(1040) },
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Section 5: invariants, focused
// ---------------------------------------------------------------------------

describe("section 5: invariants", () => {
  it("I1: cash = RTA + envelopes in a mixed month", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .assign(PAY, JUN, R(25))
      .spend("Checking", "Mercado", R(120), d(JUN, 5))
      .spend("Card", "Mercado", R(50), d(JUN, 6))
      .spend("Card", null, R(10), d(JUN, 7));
    // Checking 880. RTA 1000-125 = 875. Mercado -70 + credit 50 = -20. Payment 0 funded + 25 assigned = 25.
    // 875 - 20 + 25 = 880.
    const r = check(s.build(), JUN, {
      rta: R(875),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(170), available: -R(70), cashOverspend: R(20), creditOverspend: R(50) } },
      pays: { [PAY]: { assigned: R(25), funded: 0, available: R(25), debt: R(60), underfunded: R(35) } },
      bal: { Checking: R(880), Card: -R(60) },
    });
    expect(cashTotal(s.build())).toBe(r.readyToAssign - R(20) + R(25));
  });

  it("I2: debt - available = underfunded when positive (and 0 otherwise)", () => {
    const s = base().startingBalance("Card", -R(100), d(JUN, 1)).assign(PAY, JUN, R(40));
    // 100-40 = 60.
    const r = check(s.build(), JUN, { rta: R(960), pays: { [PAY]: { available: R(40), debt: R(100), underfunded: R(60) } } });
    expect(r.payments[PAY].debt - r.payments[PAY].available).toBe(r.payments[PAY].underfunded);
  });

  it("I3: moving money between categories keeps RTA and the envelope total", () => {
    const s = base().assign("Mercado", JUN, R(200)).assign("Lazer", JUN, R(50)).spend("Checking", "Mercado", R(80), d(JUN, 4));
    // Before: Mercado 120, Lazer 50, RTA 750. Move 100 Mercado -> Lazer: Mercado 20, Lazer 150, RTA 750.
    const b = s.build();
    assertI3(b, JUN, "Mercado", "Lazer", R(100));
    const moved = s.assign("Mercado", JUN, -R(100)).assign("Lazer", JUN, R(100)).build();
    check(moved, JUN, {
      rta: R(750),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(80), available: R(20) }, Lazer: { ...zeroCat, assigned: R(150), available: R(150) } },
    });
  });

  it("I3: money landing in a credit-overspent category shifts on to the payment category", () => {
    const s = base().assign("Mercado", JUN, R(100)).assign("Lazer", JUN, R(100)).spend("Card", "Mercado", R(150), d(JUN, 4));
    // Before: Mercado -50 credit 50, funded 100; Lazer 100; payment 100; RTA 800. Envelope total -50+50+100+100 = 200.
    const b = s.build();
    assertI3(b, JUN, "Lazer", "Mercado", R(50));
    // After moving 50 Lazer -> Mercado: Mercado avail 0, funded 150; Lazer 50; payment 150; RTA 800; total 0+50+0+150 = 200.
    const moved = s.assign("Lazer", JUN, -R(50)).assign("Mercado", JUN, R(50)).build();
    check(moved, JUN, {
      rta: R(800),
      cats: { Mercado: { ...zeroCat, assigned: R(150), activity: -R(150) }, Lazer: { ...zeroCat, assigned: R(50), available: R(50) } },
      pays: { [PAY]: { funded: R(150), available: R(150), debt: R(150), underfunded: 0 } },
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("edge cases", () => {
  it("edge: a month with no activity between active months carries Available (month list not trusted)", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Checking", "Mercado", R(30), d(JUN, 5))
      .spend("Checking", "Mercado", R(20), d(AUG, 5));
    // JUL has no rows and is absent from budget.months. Carryover 70; RTA 1000-100 = 900.
    expect(s.build().months).toEqual([JUN, AUG]);
    check(s.build(), JUL, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, carryover: R(70), available: R(70) } },
      invariants: false,
    });
    // AUG: carryover 70, activity -20, available 50; checking 950 = 900 + 50.
    check(s.build(), AUG, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, carryover: R(70), activity: -R(20), available: R(50) } },
      bal: { Checking: R(950) },
    });
  });

  it("edge: carryover crosses a year boundary", () => {
    const s = scenario({ cash: ["Checking"], categories: ["Mercado", "Lazer"] })
      .startingBalance("Checking", R(1000), "2025-12-01")
      .assign("Mercado", 202512, R(100));
    check(s.build(), 202601, { rta: R(900), cats: { Mercado: { ...zeroCat, carryover: R(100), available: R(100) } } });
  });

  it("edge: negative assignment (un-assigning below zero) is cash overspending", () => {
    const s = base().assign("Mercado", JUN, -R(50));
    // JUN: avail -50, cardSpend 0 -> cash 50. RTA 1000+50 = 1050. I1: 1000 = 1050 - 50.
    check(s.build(), JUN, { rta: R(1050), cats: { Mercado: { ...zeroCat, assigned: -R(50), available: -R(50), cashOverspend: R(50) } } });
    // JUL: RTA 1050-50 = 1000; Mercado carries 0.
    check(s.build(), JUL, { rta: R(1000), cats: { Mercado: zeroCat } });
  });

  it("edge: negative assignment after a positive one reduces the carried envelope", () => {
    const s = base().assign("Mercado", JUN, R(100)).assign("Mercado", JUL, -R(30));
    // JUL: carryover 100, assigned -30, avail 70. RTA 1000-100+30 = 930.
    check(s.build(), JUL, { rta: R(930), cats: { Mercado: { ...zeroCat, assigned: -R(30), carryover: R(100), available: R(70) } } });
  });

  it("edge: negative assignment to a payment category", () => {
    const s = base().assign(PAY, JUN, -R(40));
    // JUN: available -40 (P5-style cash overspend); RTA 1040. JUL: RTA 1000, available 0.
    check(s.build(), JUN, { rta: R(1040), pays: { [PAY]: { assigned: -R(40), available: -R(40), debt: 0 } } });
    check(s.build(), JUL, { rta: R(1000), pays: { [PAY]: { assigned: 0, available: 0 } } });
  });

  it("L3: months before the first ledger month are all zeros (even with later assignments)", () => {
    const s = base().assign("Mercado", JUN, R(100)).assign(PAY, JUN, R(20));
    // First ledger month is JUN (starting balance + assignments). MAR: RTA and every figure 0.
    check(s.build(), MAR, {
      rta: 0,
      cats: { Mercado: zeroCat, Lazer: zeroCat },
      pays: { [PAY]: { assigned: 0, funded: 0, payments: 0, available: 0, debt: 0, underfunded: 0 } },
      invariants: false,
    });
    check(base().build(), MAR, { rta: 0, cats: { Mercado: zeroCat }, invariants: false });
  });

  it("L3: an assignment alone starts the ledger; the month after the last data carries forward", () => {
    const s = scenario({ cash: ["Checking"], categories: ["Mercado", "Lazer"] })
      .assign("Mercado", JUN, R(100))
      .startingBalance("Checking", R(1000), d(JUL, 1));
    // First ledger month JUN (assignment): R3 gives RTA -100 and Mercado 100. MAY is before it: all 0.
    check(s.build(), 202605, { rta: 0, cats: { Mercado: zeroCat }, invariants: false });
    check(s.build(), JUN, { rta: -R(100), cats: { Mercado: { ...zeroCat, assigned: R(100), available: R(100) } }, invariants: false });
    // JUL: RTA 1000-100 = 900, carryover 100. Two months after the last data (SEP): same.
    check(s.build(), JUL, { rta: R(900), cats: { Mercado: { ...zeroCat, carryover: R(100), available: R(100) } } });
    check(s.build(), SEP, { rta: R(900), cats: { Mercado: { ...zeroCat, carryover: R(100), available: R(100) } } });
  });

  it("L2: upcoming transactions are ignored entirely", () => {
    const setup = (): Scenario => base().startingBalance("Card", -R(100), d(JUN, 1)).assign("Mercado", JUN, R(100));
    const withUpcoming = setup()
      .spend("Card", "Mercado", R(50), d(JUN, 5), { upcoming: true })
      .inflow("Checking", null, R(200), d(JUN, 6), { upcoming: true })
      .transfer("Checking", "Card", R(80), d(JUN, 7), { upcoming: true })
      .build();
    const without = setup().build();
    // RTA 1000-100 = 900; Mercado 100 untouched; payment 0; debt 100; balances unchanged.
    const r = check(withUpcoming, JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), available: R(100) } },
      pays: { [PAY]: { funded: 0, payments: 0, available: 0, debt: R(100), underfunded: R(100) } },
      bal: { Checking: R(1000), Card: -R(100) },
    });
    expect(r).toEqual(computeBudgetMonth(without, JUN));
  });

  describe("splits attribute per leg", () => {
    it("L4: cash split across two categories", () => {
      const s = base()
        .assign("Mercado", JUN, R(100))
        .assign("Lazer", JUN, R(100))
        .split("Checking", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: "Lazer", cents: -R(40) }], d(JUN, 10));
      // Mercado 100-60 = 40; Lazer 100-40 = 60; RTA 800; checking 900 = 800+40+60.
      check(s.build(), JUN, {
        rta: R(800),
        cats: {
          Mercado: { ...zeroCat, assigned: R(100), activity: -R(60), available: R(40) },
          Lazer: { ...zeroCat, assigned: R(100), activity: -R(40), available: R(60) },
        },
        bal: { Checking: R(900) },
      });
    });

    it("L4: cash split with an uncategorized leg hits RTA for that leg (R4)", () => {
      const s = base()
        .assign("Mercado", JUN, R(100))
        .split("Checking", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: null, cents: -R(40) }], d(JUN, 10));
      // Mercado 40; RTA 1000-100-40 = 860; checking 900 = 860+40.
      check(s.build(), JUN, { rta: R(860), cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(60), available: R(40) } }, bal: { Checking: R(900) } });
    });

    it("L4: card split with one categorized leg and one uncategorized leg", () => {
      const s = base()
        .assign("Mercado", JUN, R(100))
        .split("Card", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: null, cents: -R(40) }], d(JUN, 10));
      // Categorized leg: Mercado 100-60 = 40, funded 60, payment 60. Uncategorized leg (R5): no budget effect.
      // Card -100: debt 100, underfunded 100-60 = 40. RTA 900. I1: 1000 = 900+40+60.
      check(s.build(), JUN, {
        rta: R(900),
        cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(60), available: R(40) } },
        pays: { [PAY]: { funded: R(60), available: R(60), debt: R(100), underfunded: R(40) } },
        bal: { Card: -R(100) },
      });
    });

    it("L4: card split with legs in two categories overspends each on its own", () => {
      const s = base()
        .assign("Mercado", JUN, R(50))
        .split("Card", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: "Lazer", cents: -R(40) }], d(JUN, 10));
      // Mercado 50-60 = -10, credit 10, funded 50. Lazer 0-40 = -40, credit 40, funded 0. Payment 50.
      // Debt 100, underfunded 50. RTA 950. I1: 1000 = 950 + (-10+10) + (-40+40) + 50.
      check(s.build(), JUN, {
        rta: R(950),
        cats: {
          Mercado: { ...zeroCat, assigned: R(50), activity: -R(60), available: -R(10), creditOverspend: R(10) },
          Lazer: { ...zeroCat, activity: -R(40), available: -R(40), creditOverspend: R(40) },
        },
        pays: { [PAY]: { funded: R(50), available: R(50), debt: R(100), underfunded: R(50) } },
      });
    });
  });
});

describe("section 4b: ledger, months, splits", () => {
  it("L1: balances come from the ledger; clearedBalance/unclearedBalance are never read", () => {
    const honest = base().startingBalance("Card", -R(100), d(JUN, 1)).assign("Mercado", JUN, R(100)).spend("Card", "Mercado", R(40), d(JUN, 5));
    const lying = honest.build();
    for (const a of lying.accounts) {
      a.clearedBalance = 987_654;
      a.unclearedBalance = -123_456;
    }
    // Ledger: checking 1000, card -140. RTA 1000-100 = 900; Mercado 60; funded 40; debt 140; underfunded 140-40 = 100.
    const want: Expected = {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(40), available: R(60) } },
      pays: { [PAY]: { funded: R(40), available: R(40), debt: R(140), underfunded: R(100) } },
      invariants: false, // the lying balances would break the I1/I2 helpers by design
    };
    expect(computeBudgetMonth(lying, JUN)).toEqual(computeBudgetMonth(honest.build(), JUN));
    check(lying, JUN, want);
  });

  it("L1: no implicit opening cash; the card debt is only what the ledger says", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Card"], categories: ["Mercado"] }).build();
    b.accounts[0].clearedBalance = R(5000); // account says 5000 cash, ledger is empty
    b.accounts[1].clearedBalance = -R(500); // account says card debt, ledger is empty
    const r = computeBudgetMonth(b, JUN);
    expect(r.readyToAssign).toBe(0);
    expect(r.payments[PAY]).toMatchObject({ debt: 0, underfunded: 0, available: 0 });
  });

  it("L1: uncleared (non-upcoming) rows count in the ledger", () => {
    const s = base().add({ accountId: "Card", date: d(JUN, 2), categoryId: null, outflow: R(90), cleared: "uncleared" });
    // Card -90 from an uncleared row: debt 90.
    check(s.build(), JUN, { rta: R(1000), pays: { [PAY]: { debt: R(90), underfunded: R(90) } } });
  });

  it("L4: parent category is ignored and S1/S2 apply to category month totals, not per leg", () => {
    const s = base().split("Card", [{ categoryId: "Mercado", cents: -R(60) }, { categoryId: "Mercado", cents: R(40) }], d(JUN, 5));
    const b = s.build();
    b.transactions[b.transactions.length - 1].categoryId = "Lazer"; // parent category must be ignored
    // Mercado cardNet -60+40 = -20; avail 0-20 = -20; cardSpend 20; credit 20; cash 0; funded 0.
    // (Per leg it would have been: 60 spend overspent, 40 refund leaving the payment category.) Lazer untouched.
    check(b, JUN, {
      rta: R(1000),
      cats: { Mercado: { ...zeroCat, activity: -R(20), available: -R(20), creditOverspend: R(20) }, Lazer: zeroCat },
      pays: { [PAY]: { funded: 0, available: 0, debt: R(20), underfunded: R(20) } },
    });
  });

  it("L4: separate transactions in one category are also netted per month", () => {
    const s = base().spend("Card", "Mercado", R(60), d(JUN, 5)).inflow("Card", "Mercado", R(40), d(JUN, 6));
    check(s.build(), JUN, {
      rta: R(1000),
      cats: { Mercado: { ...zeroCat, activity: -R(20), available: -R(20), creditOverspend: R(20) } },
      pays: { [PAY]: { funded: 0, available: 0, debt: R(20), underfunded: R(20) } },
    });
  });

  it("L5: activity = cash net + card net of the category's legs (category.activity is never read)", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .spend("Checking", "Mercado", R(30), d(JUN, 2))
      .spend("Card", "Mercado", R(20), d(JUN, 3))
      .inflow("Checking", "Mercado", R(5), d(JUN, 4));
    const b = s.build();
    for (const c of b.categories) c.activity = { [JUN]: 777_777 };
    // activity -30-20+5 = -45; avail 100-45 = 55; funded 20; payment 20. RTA 900.
    check(b, JUN, {
      rta: R(900),
      cats: { Mercado: { ...zeroCat, assigned: R(100), activity: -R(45), available: R(55) } },
      pays: { [PAY]: { funded: R(20), available: R(20), debt: R(20), underfunded: 0 } },
    });
  });

  it("L6: a reconciliation adjustment is an ordinary uncategorized row (cash moves RTA, card does not)", () => {
    const adj = (account: string, inflow: number, outflow: number): Parameters<Scenario["add"]>[0] => ({
      accountId: account,
      date: d(JUN, 28),
      payee: "Reconciliation Balance Adjustment",
      categoryId: null,
      inflow,
      outflow,
    });
    const s = base().add(adj("Checking", R(40), 0)).add(adj("Checking", 0, R(25)));
    // Cash: RTA 1000+40-25 = 1015.
    check(s.build(), JUN, { rta: R(1015), bal: { Checking: R(1015) } });
    // Card adjustment -15: no budget effect, debt 15, underfunded 15.
    s.add(adj("Card", 0, R(15)));
    check(s.build(), JUN, {
      rta: R(1015),
      pays: { [PAY]: { funded: 0, available: 0, debt: R(15), underfunded: R(15) } },
      bal: { Card: -R(15) },
    });
  });
});

// ---------------------------------------------------------------------------
// Property test: I1 and I2 over seeded random budgets
// ---------------------------------------------------------------------------

/** Tiny deterministic PRNG (mulberry32): returns floats in [0, 1). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CATS = ["Mercado", "Lazer", "Casa", "Saude", "Outros"];
const CASH = ["Checking", "Savings"];
const CARDS = ["CardA", "CardB"];

function randomBudget(seed: number): Budget {
  const rng = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T,>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];
  const nMonths = int(3, 6);
  const months = Array.from({ length: nMonths }, (_, i) => 202601 + i);
  const s = scenario({ cash: CASH, cards: CARDS, categories: CATS });

  s.startingBalance("Checking", int(50_000, 500_000), d(months[0], 1));
  s.startingBalance("Savings", int(0, 200_000), d(months[0], 1));
  for (const c of CARDS) {
    // P7: some cards start positive (credit balance), the rest in debt.
    if (rng() < 0.15) s.startingBalance(c, int(1_000, 60_000), d(months[0], 1));
    else if (rng() < 0.7) s.startingBalance(c, -int(1_000, 150_000), d(months[0], 1));
  }

  for (const m of months) {
    for (const c of CATS) {
      if (rng() < 0.7) s.assign(c, m, rng() < 0.15 ? -int(100, 5_000) : int(100, 30_000));
    }
    for (const c of CARDS) if (rng() < 0.5) s.assign(payId(c), m, rng() < 0.15 ? -int(100, 3_000) : int(100, 40_000));

    const nTx = int(3, 10);
    for (let i = 0; i < nTx; i++) {
      const day = int(1, 27);
      const cat = rng() < 0.85 ? pick(CATS) : null;
      const kind = int(0, 8);
      if (kind === 0) s.spend(pick(CASH), cat, int(100, 20_000), d(m, day)); // cash spend
      else if (kind === 1 || kind === 2) s.spend(pick(CARDS), cat, int(100, 30_000), d(m, day)); // card spend
      else if (kind === 3) s.inflow(pick(CARDS), cat, int(100, 20_000), d(m, day)); // card refund (any month, any size)
      else if (kind === 4) s.inflow(pick(CASH), cat, int(100, 15_000), d(m, day)); // income or cash refund
      else if (kind === 5) s.transfer(pick(CASH), pick(CARDS), int(100, 50_000), d(m, day)); // card payment
      else if (kind === 6) {
        const from = pick(CASH);
        s.transfer(from, CASH.find((c) => c !== from) as string, int(100, 20_000), d(m, day)); // cash to cash
      } else if (kind === 7) s.transfer(pick(CARDS), pick(CASH), int(100, 8_000), d(m, day)); // cash advance (P2)
      else if (rng() < 0.5) s.inflow(pick(CARDS), null, int(100, 5_000), d(m, day)); // statement credit
      else s.spend(pick(CARDS), null, int(100, 5_000), d(m, day)); // interest or uncategorized card spend
    }
  }
  return s.build();
}

describe("property: I1 and I2 on random budgets", () => {
  it("I1/I2: hold for every month of 220 seeded random budgets (failure message carries the seed)", () => {
    const N = 220;
    for (let seed = 1; seed <= N; seed++) {
      const full = randomBudget(seed);
      for (const m of full.months) {
        const b = truncateBudget(full, m); // I1 holds only with nothing after the viewed month
        try {
          const r = computeBudgetMonth(b, m);
          assertI1(b, r);
          assertI2(b, r);
        } catch (e) {
          throw new Error(`property failed: seed=${seed} month=${m}: ${(e as Error).message}`);
        }
      }
    }
  });
});

// ---------------------------------------------------------------------------
// L7: empty splits are a plain transaction
// ---------------------------------------------------------------------------

describe("L7: splits [] is a plain transaction", () => {
  const noSplits = { splits: [] };

  it("L7: a cash categorized transaction with splits [] counts as activity", () => {
    const s = base().assign("Mercado", JUN, R(100)).add({ accountId: "Checking", date: d(JUN), categoryId: "Mercado", outflow: R(30), ...noSplits });
    check(s.build(), JUN, { rta: R(1000) - R(100), cats: { Mercado: { activity: -R(30), available: R(70) } } });
  });

  it("L7: a cash uncategorized transaction with splits [] lowers RTA (R4)", () => {
    const s = base().add({ accountId: "Checking", date: d(JUN), categoryId: null, outflow: R(30), ...noSplits });
    check(s.build(), JUN, { rta: R(970) });
  });

  it("L7: a card categorized transaction with splits [] is funded spending", () => {
    const s = base()
      .assign("Mercado", JUN, R(100))
      .add({ accountId: "Card", date: d(JUN), categoryId: "Mercado", outflow: R(30), ...noSplits });
    check(s.build(), JUN, {
      rta: R(900),
      cats: { Mercado: { activity: -R(30), available: R(70) } },
      pays: { [PAY]: { funded: R(30), available: R(30), debt: R(30) } },
    });
  });

  it("L7: a card uncategorized transaction with splits [] only moves the card balance (R5)", () => {
    const s = base().add({ accountId: "Card", date: d(JUN), categoryId: null, outflow: R(30), ...noSplits });
    check(s.build(), JUN, { rta: R(1000), pays: { [PAY]: { funded: 0, available: 0, debt: R(30), underfunded: R(30) } } });
  });
});

// ---------------------------------------------------------------------------
// P8: one-to-one card link
// ---------------------------------------------------------------------------

/** Adds a payment-group category (no card of its own) to a built budget. */
function addPaymentCategory(b: Budget, id: string, name: string): void {
  b.categories.push({ id, groupId: "g-pay", name, assigned: {}, activity: {} });
  b.groups.find((g) => g.id === "g-pay")?.categoryIds.push(id);
}

/** Renames a category in a built budget. */
function rename(b: Budget, id: string, name: string): void {
  const c = b.categories.find((x) => x.id === id);
  if (!c) throw new Error(`no category ${id}`);
  c.name = name;
}

describe("P8: one-to-one card link", () => {
  const scenarioFor = (): Scenario =>
    base()
      .assign("Mercado", JUN, R(100))
      .spend("Card", "Mercado", R(40), d(JUN));

  it("P8: two payment categories and one card, one name-matched: only the match is the envelope", () => {
    const b = scenarioFor().assign("Extra", JUN, R(25)).build();
    addPaymentCategory(b, "Extra", "Extra");
    b.categories.find((c) => c.id === "Extra")!.assigned[JUN] = R(25);
    const r = check(b, JUN, { rta: R(1000) - R(100) - R(25), pays: { [PAY]: { accountId: "Card", funded: R(40), available: R(40) } } });
    expect(Object.keys(r.payments)).toEqual([PAY]);
    expect(r.categories.Extra).toMatchObject({ assigned: R(25), available: R(25) });
  });

  it("P8: two payment categories and one card, neither name-matched: nothing pairs", () => {
    const b = scenarioFor().build();
    rename(b, PAY, "Alpha");
    addPaymentCategory(b, "Beta", "Beta");
    b.categories.find((c) => c.id === "Beta")!.assigned[JUN] = R(10);
    b.categories.find((c) => c.id === PAY)!.assigned[JUN] = R(5);
    const r = check(b, JUN, { rta: R(1000) - R(100) - R(15) });
    expect(Object.keys(r.payments)).toEqual(["card:Card"]);
    expect(r.payments["card:Card"]).toMatchObject({ accountId: "Card", assigned: 0, funded: R(40), available: R(40), debt: R(40) });
    expect(r.categories[PAY]).toMatchObject({ assigned: R(5), available: R(5) });
    expect(r.categories.Beta).toMatchObject({ assigned: R(10), available: R(10) });
  });

  it("P8: a payment category whose name differs pairs when it is the only one for the only card", () => {
    const b = scenarioFor().build();
    rename(b, PAY, "Cartao renamed");
    b.categories.find((c) => c.id === PAY)!.assigned[JUN] = R(5);
    const r = check(b, JUN, { rta: R(1000) - R(100) - R(5) });
    expect(Object.keys(r.payments)).toEqual([PAY]);
    expect(r.payments[PAY]).toMatchObject({ accountId: "Card", assigned: R(5), funded: R(40), available: R(45) });
    expect(r.categories[PAY]).toBeUndefined();
  });

  it("P8: a card with no payment category gets an envelope under card:<id>", () => {
    const b = scenarioFor().build();
    b.categories = b.categories.filter((c) => c.id !== PAY);
    b.groups.find((g) => g.id === "g-pay")!.categoryIds = [];
    const r = check(b, JUN, { rta: R(900) });
    expect(Object.keys(r.payments)).toEqual(["card:Card"]);
    expect(r.payments["card:Card"]).toMatchObject({ accountId: "Card", assigned: 0, funded: R(40), available: R(40), debt: R(40), underfunded: 0 });
  });

  it("P8: two cards never share one category (single-card fallback is gone)", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa", "Master"], categories: ["Mercado"] })
      .startingBalance("Checking", R(1000), d(JUN, 1))
      .assign("Mercado", JUN, R(100))
      .spend("Visa", "Mercado", R(40), d(JUN))
      .spend("Master", "Mercado", R(10), d(JUN))
      .build();
    rename(b, payId("Master"), "Other");
    const r = check(b, JUN, { rta: R(900) });
    // Visa matches by name; Master has one card and one category left, so they pair.
    expect(Object.keys(r.payments).sort()).toEqual([payId("Master"), payId("Visa")].sort());
    expect(r.payments[payId("Visa")].funded).toBe(R(40));
    expect(r.payments[payId("Master")].funded).toBe(R(10));
  });
});
