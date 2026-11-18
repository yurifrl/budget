import { describe, it, expect } from "bun:test";
import {
  buildAutoAssignStrategy,
  buildAutoAssignStrategies,
  historyMonths,
  type AutoAssignCategory,
  buildAutoAssignSnapshot,
  type AutoAssignSnapshot,
} from "./auto-assign";
import { dateIn, payId, scenario } from "./zeroSum.fixtures";

/** Quick category literal: `assigned`/`activity` per YYYYMM key; `available` is the engine's figure (set it where a strategy reads it). */
function cat(partial: Partial<AutoAssignCategory>): AutoAssignCategory {
  return {
    id: "cat",
    name: "Cat",
    groupName: "Group",
    assigned: {},
    activity: {},
    kind: "spending",
    available: 0,
    underfunded: 0,
    target: null,
    ...partial,
  };
}

const START = 202601;
const SEP = 202609;

describe("historyMonths", () => {
  it("returns the last 6 months before the funding month", () => {
    expect(historyMonths(SEP, START)).toEqual([202608, 202607, 202606, 202605, 202604, 202603]);
  });

  it("stops at the budget's first month", () => {
    expect(historyMonths(202603, START)).toEqual([202602, 202601]);
  });
});

describe("buildAutoAssignStrategy", () => {
  const snap = (categories: AutoAssignCategory[], month = SEP): AutoAssignSnapshot => ({
    month,
    startMonth: START,
    categories,
  });

  it("underfunded fills each underfunded target up to neededBy", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", target: { categoryId: "a", kind: "monthly", amountCents: 1000, config: {} }, assigned: { [SEP]: 400 } }),
        cat({ id: "b", target: { categoryId: "b", kind: "monthly", amountCents: 1000, config: {} }, assigned: { [SEP]: 1000 } }),
        cat({ id: "c" }),
      ]),
      "underfunded",
    );
    expect(s.rows).toEqual([
      { categoryId: "a", assignCents: 1000, deltaCents: 600 },
    ]);
    expect(s.totalCents).toBe(600);
  });

  it("assignedLastMonth copies last month's positive assignments", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", assigned: { 202608: 700, [SEP]: 100 } }),
        cat({ id: "b", assigned: { [SEP]: 0 } }), // last month 0 → no row
        cat({ id: "c", assigned: { 202608: 250, [SEP]: 250 } }), // equal → no row
      ]),
      "assignedLastMonth",
    );
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 700, deltaCents: 600 }]);
  });

  it("spentLastMonth assigns last month's net outflow", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", activity: { 202608: -450 } }),
        cat({ id: "b", activity: { 202608: 120 } }), // net inflow → no row
      ]),
      "spentLastMonth",
    );
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 450, deltaCents: 450 }]);
  });

  it("average strategies round the mean over the last 6 months", () => {
    const data = snap([
        cat({ id: "a", assigned: { 202606: 100, 202607: 200, 202608: 300, [SEP]: 0 } }),
        cat({ id: "b", activity: { 202606: -100, 202607: -101, 202608: -202, [SEP]: 0 } }),
        cat({ id: "new", assigned: { [SEP]: 5 } }), // untouched in window → no row
      ]);
    const s = buildAutoAssignStrategy(
      data,
      "averageAssigned",
    );
    const spent = buildAutoAssignStrategy(data, "averageSpent");
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 100, deltaCents: 100 }]); // 600/6 (zero months count)
    expect(spent.rows).toEqual([{ categoryId: "b", assignCents: 67, deltaCents: 67 }]); // 403/6
    expect(s.monthsUsed).toEqual([202608, 202607, 202606, 202605, 202604, 202603]);
  });

  it("average strategies skip months before the budget start", () => {
    const s = buildAutoAssignStrategy(
      snap([cat({ id: "a", assigned: { 202601: 60, [SEP]: 0 } })], 202602),
      "averageAssigned",
    );
    expect(s.monthsUsed).toEqual([202601]);
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 60, deltaCents: 60 }]);
  });

  it("reduceOverfunding pulls categories funded past target back to it", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", target: { categoryId: "a", kind: "monthly", amountCents: 500, config: {} }, assigned: { [SEP]: 800 } }),
        cat({ id: "b", target: { categoryId: "b", kind: "monthly", amountCents: 500, config: {} }, assigned: { [SEP]: 500 } }),
      ]),
      "reduceOverfunding",
    );
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 500, deltaCents: -300 }]);
    expect(s.totalCents).toBe(-300);
  });

  it("resetAvailable lands every available on zero (the engine's unified Available)", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", assigned: { [SEP]: 900 }, available: 600 }),
        cat({ id: "b", available: -250 }), // overspent
        cat({ id: "c", assigned: { 202601: 100, [SEP]: 0 }, available: 100 }), // carryover
        cat({ id: "d", available: 0 }), // already zero: no row
        cat({ id: "pay", kind: "payment", assigned: { [SEP]: 400 }, available: 400 }),
      ]),
      "resetAvailable",
    );
    expect(s.rows).toEqual([
      { categoryId: "a", assignCents: 300, deltaCents: -600 },
      { categoryId: "b", assignCents: 250, deltaCents: 250 },
      { categoryId: "c", assignCents: -100, deltaCents: -100 },
      { categoryId: "pay", assignCents: 0, deltaCents: -400 },
    ]);
  });

  it("underfunded fills a card payment category's engine underfunded (debt not covered by Available)", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "pay", kind: "payment", assigned: { [SEP]: 300 }, available: 300, underfunded: 700 }),
        cat({ id: "covered", kind: "payment", assigned: { [SEP]: 900 }, available: 900, underfunded: 0 }),
      ]),
      "underfunded",
    );
    expect(s.rows).toEqual([{ categoryId: "pay", assignCents: 1000, deltaCents: 700 }]);
  });

  it("resetAssigned zeroes the month's assignments", () => {
    const s = buildAutoAssignStrategy(
      snap([
        cat({ id: "a", assigned: { [SEP]: 900 } }),
        cat({ id: "b", assigned: { 202601: 900 } }),
      ]),
      "resetAssigned",
    );
    expect(s.rows).toEqual([{ categoryId: "a", assignCents: 0, deltaCents: -900 }]);
  });

  it("buildAutoAssignStrategies returns all panel strategies in order", () => {
    const all = buildAutoAssignStrategies(snap([cat({ id: "a", assigned: { [SEP]: 10 } })]));
    expect(all.map((s) => s.key)).toEqual([
      "underfunded",
      "assignedLastMonth",
      "spentLastMonth",
      "averageAssigned",
      "averageSpent",
      "reduceOverfunding",
      "resetAvailable",
      "resetAssigned",
    ]);
  });
});

describe("buildAutoAssignSnapshot (figures come from the zero-sum engine)", () => {
  // Checking 1000; a: 900 assigned, 300 spent in SEP (available 600); b: 250
  // spent in SEP, nothing assigned (cash overspend -250); card debt 1000 with
  // 300 assigned (underfunded 700, available 300 + funded 0).
  const budget = () =>
    scenario({ cash: ["Checking"], cards: ["Card"], categories: ["a", "b"] })
      .startingBalance("Checking", 100000, dateIn(202601, 1))
      .startingBalance("Card", -1000, dateIn(202601, 1))
      .assign("a", SEP, 900)
      .spend("Checking", "a", 300, dateIn(SEP))
      .spend("Checking", "b", 250, dateIn(SEP))
      .assign(payId("Card"), SEP, 300)
      .build();

  it("carries engine Available, kind and underfunded; activity is derived from transactions", () => {
    const snapshot = buildAutoAssignSnapshot(budget(), SEP);
    const byId = Object.fromEntries(snapshot.categories.map((c) => [c.id, c]));
    expect(byId.a).toMatchObject({ kind: "spending", available: 600, underfunded: 0 });
    expect(byId.a.activity).toEqual({ [SEP]: -300 });
    expect(byId.b).toMatchObject({ kind: "spending", available: -250 });
    expect(byId[payId("Card")]).toMatchObject({ kind: "payment", available: 300, underfunded: 700 });
  });

  it("resetAvailable and underfunded over a real budget", () => {
    const snapshot = buildAutoAssignSnapshot(budget(), SEP);
    expect(buildAutoAssignStrategy(snapshot, "resetAvailable").rows).toEqual([
      { categoryId: "a", assignCents: 300, deltaCents: -600 },
      { categoryId: "b", assignCents: 250, deltaCents: 250 },
      { categoryId: payId("Card"), assignCents: 0, deltaCents: -300 },
    ]);
    expect(buildAutoAssignStrategy(snapshot, "underfunded").rows).toEqual([
      { categoryId: payId("Card"), assignCents: 1000, deltaCents: 700 },
    ]);
  });
});
