/**
 * The unified per-category figures and the per-(budget, month) cache that sit on
 * top of `computeBudgetMonth` (the engine's own rules live in zeroSum.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { budgetMonth, categoryFigures, computeBudgetMonth, sumFigures } from "./zeroSum";
import { dateIn, payId, scenario } from "./__fixtures__/zeroSum.fixtures";

const JUN = 202606;
const JUL = 202607;
const d = (day: number, month = JUN): string => dateIn(month, day);
const PAY = payId("Card");

/** Checking 1000, Mercado assigned 100 (30 cash + 90 card = -20 available), card payment assigned 40, 25 paid. */
const build = () =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["Mercado", "Lazer"] })
    .startingBalance("Checking", 100000, d(1, 202605))
    .assign("Mercado", JUN, 10000)
    .assign("Lazer", JUN, 2000)
    .assign(PAY, JUN, 4000)
    .spend("Checking", "Mercado", 3000, d(3))
    .spend("Card", "Mercado", 9000, d(4))
    .transfer("Checking", "Card", 2500, d(8))
    .build();

describe("categoryFigures", () => {
  const bm = computeBudgetMonth(build(), JUN);

  it("a spending category: its CategoryMonth assigned / activity / available", () => {
    // 10000 - 3000 - 9000 = -2000: credit overspending, available kept negative.
    expect(categoryFigures(bm, "Mercado")).toEqual({ kind: "spending", assigned: 10000, activity: -12000, available: -2000 });
    expect(categoryFigures(bm, "Lazer")).toEqual({ kind: "spending", assigned: 2000, activity: 0, available: 2000 });
  });

  it("a payment category: activity = funded - payments, Available = PaymentMonth.available", () => {
    // funded 9000 - 2000 credit = 7000; payments 2500; available 4000 + 7000 - 2500.
    expect(bm.payments[PAY]).toMatchObject({ assigned: 4000, funded: 7000, payments: 2500, available: 8500 });
    expect(categoryFigures(bm, PAY)).toEqual({ kind: "payment", assigned: 4000, activity: 4500, available: 8500 });
  });

  it("an unknown id is zeros, as a spending category", () => {
    expect(categoryFigures(bm, "nope")).toEqual({ kind: "spending", assigned: 0, activity: 0, available: 0 });
  });

  it("an empty month (before the first ledger month) is zeros for everything", () => {
    const early = computeBudgetMonth(build(), 202601);
    expect(categoryFigures(early, "Mercado")).toEqual({ kind: "spending", assigned: 0, activity: 0, available: 0 });
    expect(categoryFigures(early, PAY)).toEqual({ kind: "payment", assigned: 0, activity: 0, available: 0 });
  });
});

describe("sumFigures", () => {
  const bm = computeBudgetMonth(build(), JUN);

  it("sums spending and payment categories alike", () => {
    expect(sumFigures(bm, ["Mercado", "Lazer", PAY])).toEqual({
      assigned: 10000 + 2000 + 4000,
      activity: -12000 + 0 + 4500,
      available: -2000 + 2000 + 8500,
    });
  });

  it("no ids is zero; unknown ids add nothing", () => {
    expect(sumFigures(bm, [])).toEqual({ assigned: 0, activity: 0, available: 0 });
    expect(sumFigures(bm, ["nope"])).toEqual({ assigned: 0, activity: 0, available: 0 });
  });

  it("accepts any iterable", () => {
    expect(sumFigures(bm, new Set(["Lazer"])).available).toBe(2000);
  });
});

describe("budgetMonth (cache)", () => {
  it("returns the engine's result", () => {
    const b = build();
    expect(budgetMonth(b, JUN)).toEqual(computeBudgetMonth(b, JUN));
  });

  it("computes once per (budget, month): the same object comes back", () => {
    const b = build();
    expect(budgetMonth(b, JUN)).toBe(budgetMonth(b, JUN));
    expect(budgetMonth(b, JUL)).toBe(budgetMonth(b, JUL));
    expect(budgetMonth(b, JUL)).not.toBe(budgetMonth(b, JUN));
    expect(budgetMonth(b, JUL).month).toBe(JUL);
  });

  it("a new budget snapshot starts empty (immutable snapshots are the cache key)", () => {
    const b = build();
    const first = budgetMonth(b, JUN);
    const edited = { ...b, categories: b.categories.map((c) => (c.id === "Lazer" ? { ...c, assigned: { [JUN]: 9000 } } : c)) };
    const second = budgetMonth(edited, JUN);
    expect(second).not.toBe(first);
    expect(categoryFigures(second, "Lazer").assigned).toBe(9000);
    expect(categoryFigures(first, "Lazer").assigned).toBe(2000); // the old snapshot's entry is untouched
  });
});
