import { describe, expect, it } from "bun:test";

import type { Budget, MonthKey } from "./types";

import { availableBreakdown } from "./inspector";
import { computeBudgetMonth } from "./zeroSum";
import { dateIn, payId, scenario } from "./zeroSum.fixtures";

const AUG = 202608;
const SEP = 202609;
const OCT = 202610;
const d = (m: MonthKey, day = 10): string => dateIn(m, day);

/** One cash account with money in it, one spending category "c" and one card. */
const base = () =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["c"] }).startingBalance("Checking", 100000, d(AUG, 1));

const breakdown = (b: Budget, month: MonthKey, id = "c") => availableBreakdown(computeBudgetMonth(b, month), id);
const sum = (rows: { cents: number }[]) => rows.reduce((a, r) => a + r.cents, 0);

describe("availableBreakdown (spending category)", () => {
  it("rows sum to available and match the engine (plain month)", () => {
    // August fully spent (500 in, 500 out) => no carryover; September nets 100.
    const b = base()
      .assign("c", AUG, 500)
      .spend("Checking", "c", 500, d(AUG))
      .assign("c", SEP, 400)
      .spend("Checking", "c", 300, d(SEP))
      .build();
    const bd = breakdown(b, SEP);
    expect(bd.kind).toBe("spending");
    expect(bd.available).toBe(100);
    expect(sum(bd.rows)).toBe(bd.available);
    expect(bd.rows.map((r) => r.cents)).toEqual([0, 400, -300]);
  });

  it("positive carryover carries; a cash overspend is swept at the boundary (S4)", () => {
    // 500 assigned - 350 spent leaves +150 running into September.
    const positive = base().assign("c", AUG, 500).spend("Checking", "c", 350, d(AUG)).build();
    expect(breakdown(positive, SEP).rows).toEqual([
      { key: "carryover", cents: 150 },
      { key: "assigned", cents: 0 },
      { key: "activity", cents: 0 },
    ]);
    expect(breakdown(positive, SEP).available).toBe(150);

    // 500 assigned - 650 spent = -150 at end of Aug; the overspend debits Ready
    // to Assign at the Sep rollover instead, so nothing negative carries.
    const negative = base().assign("c", AUG, 500).spend("Checking", "c", 650, d(AUG)).build();
    const bd = breakdown(negative, SEP);
    expect(bd.rows).toEqual([
      { key: "carryover", cents: 0 },
      { key: "assigned", cents: 0 },
      { key: "activity", cents: 0 },
    ]);
    expect(bd.available).toBe(0);
  });

  it("overspent month yields negative available", () => {
    const b = base().assign("c", SEP, 100).spend("Checking", "c", 250, d(SEP)).build();
    const bd = breakdown(b, SEP);
    expect(bd.available).toBe(-150);
    expect(sum(bd.rows)).toBe(bd.available);
  });

  it("card spending counts in the activity row (S1)", () => {
    const b = base().assign("c", SEP, 500).spend("Card", "c", 200, d(SEP)).build();
    const bd = breakdown(b, SEP);
    expect(bd.rows.map((r) => r.cents)).toEqual([0, 500, -200]);
    expect(bd.available).toBe(300);
  });

  it("first month of the budget has zero carryover", () => {
    const b = base().assign("c", AUG, 500).spend("Checking", "c", 200, d(AUG)).build();
    const bd = breakdown(b, AUG);
    expect(bd.rows).toEqual([
      { key: "carryover", cents: 0 },
      { key: "assigned", cents: 500 },
      { key: "activity", cents: -200 },
    ]);
    expect(bd.available).toBe(300);
  });

  it("ignores months after the queried month (future activity invisible)", () => {
    const b = base()
      .assign("c", AUG, 500)
      .spend("Checking", "c", 500, d(AUG))
      .assign("c", OCT, 999)
      .spend("Checking", "c", 999, d(OCT))
      .build();
    const bd = breakdown(b, SEP);
    expect(bd.available).toBe(0);
    expect(sum(bd.rows)).toBe(0);
  });

  it("an unknown category id is all zeros", () => {
    expect(breakdown(base().build(), AUG, "nope")).toMatchObject({ kind: "spending", available: 0 });
  });
});

describe("availableBreakdown (card payment category)", () => {
  const PAY = payId("Card");

  it("carried over, assigned, funded spending and payments sum to Available; debt and underfunded ride along", () => {
    // Aug: card debt 300 (Starting Balance), Mercado-like spend 120 funded on the card, assign 200.
    // Sep: assign 50, spend 80 on the card (funded), pay 100 from checking.
    const b = base()
      .startingBalance("Card", -300, d(AUG, 1))
      .assign("c", AUG, 500)
      .spend("Card", "c", 120, d(AUG))
      .assign(PAY, AUG, 200)
      .assign("c", SEP, 500)
      .assign(PAY, SEP, 50)
      .spend("Card", "c", 80, d(SEP))
      .transfer("Checking", "Card", 100, d(SEP))
      .build();
    const bd = breakdown(b, SEP, PAY);
    // Aug end: 200 + 120 funded = 320 carried. Sep: 320 + 50 + 80 - 100 = 350.
    expect(bd.kind).toBe("payment");
    expect(bd.rows).toEqual([
      { key: "carryover", cents: 320 },
      { key: "assigned", cents: 50 },
      { key: "funded", cents: 80 },
      { key: "payments", cents: -100 },
    ]);
    expect(bd.available).toBe(350);
    expect(sum(bd.rows)).toBe(bd.available);
    // debt: -300 - 120 - 80 + 100 = -400 => 400; underfunded 400 - 350 = 50.
    expect(bd.debt).toBe(400);
    expect(bd.underfunded).toBe(50);
  });

  it("a payment category with no activity shows zero rows and the starting debt as underfunded", () => {
    const b = base().startingBalance("Card", -250, d(AUG, 1)).build();
    const bd = breakdown(b, AUG, PAY);
    expect(bd.rows.map((r) => r.cents)).toEqual([0, 0, 0, 0]);
    expect(bd).toMatchObject({ available: 0, debt: 250, underfunded: 250 });
  });
});
