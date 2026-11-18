/**
 * Credit card payment categories — YNAB "Credit Card Payments" group
 * (docs/budget-engine-spec.md section 3).
 *
 * A payment category's Available is a carried envelope (P1), never derived from
 * the card balance; the balance only drives `debt` and `underfunded` (P4).
 * These tests pin the arithmetic of the old payment tests under the spec: the
 * debt numbers survive, the Available numbers do not.
 */

import { describe, expect, it } from "bun:test";
import { cardAccountForCategory, isCardAccount } from "./payments";
import type { Budget, MonthKey } from "./types";
import { computeBudgetMonth } from "./zeroSum";
import { dateIn, payId, scenario, type Scenario } from "./__fixtures__/zeroSum.fixtures";

const JUN: MonthKey = 202606;
const PAY = payId("Card");

/** One checking account with plenty of cash and one card; opening rows before June. */
const base = (): Scenario =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["Mercado"] }).startingBalance(
    "Checking",
    20_000_000,
    dateIn(202605, 1),
  );

const pay = (b: Budget, month: MonthKey = JUN) => computeBudgetMonth(b, month).payments[PAY];

describe("payment category figures (P1, P3, P4)", () => {
  it("a card with debt and nothing assigned has Available 0 and is fully underfunded", () => {
    const b = base().startingBalance("Card", -445369, dateIn(202605, 1)).build();
    expect(pay(b)).toMatchObject({ assigned: 0, available: 0, debt: 445369, underfunded: 445369 });
  });

  it("a card holding credit (positive balance) has no debt and no Available", () => {
    const b = base().startingBalance("Card", 5000, dateIn(202605, 1)).build();
    expect(pay(b)).toMatchObject({ available: 0, debt: 0, underfunded: 0 });
  });

  it("a zero balance means nothing to pay", () => {
    const b = base().build();
    expect(pay(b)).toMatchObject({ available: 0, debt: 0, underfunded: 0 });
  });

  it("debt sums every non-upcoming row on the card, cleared or not", () => {
    const b = base()
      .startingBalance("Card", -445369, dateIn(202605, 1))
      .add({ accountId: "Card", date: dateIn(JUN, 3), outflow: 55000, cleared: "uncleared" })
      .build();
    expect(pay(b)).toMatchObject({ debt: 500369, available: 0, underfunded: 500369 });
  });

  it("moving money out of a payment category is a negative assignment: Available goes negative, no balance term", () => {
    const b = base().startingBalance("Card", -8759990, dateIn(202605, 1)).assign(PAY, JUN, -8759990).build();
    expect(pay(b)).toMatchObject({ assigned: -8759990, available: -8759990, debt: 8759990 });
    const deeper = base().startingBalance("Card", -8759990, dateIn(202605, 1)).assign(PAY, JUN, -12000000).build();
    expect(pay(deeper).available).toBe(-12000000);
  });

  it("moving money in funds the payment one-for-one and leaves the rest underfunded", () => {
    const b = base().startingBalance("Card", -8759990, dateIn(202605, 1)).assign(PAY, JUN, 500000).build();
    expect(pay(b)).toMatchObject({ assigned: 500000, available: 500000, debt: 8759990, underfunded: 8259990 });
  });

  it("the month's assignment adds to Available and shrinks underfunded", () => {
    const b = base().startingBalance("Card", -445369, dateIn(202605, 1)).assign(PAY, JUN, 150000).build();
    expect(pay(b)).toMatchObject({ assigned: 150000, available: 150000, debt: 445369, underfunded: 295369 });
  });
});

describe("cardAccountForCategory", () => {
  it("matches the card by name", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa", "Master"] }).build();
    const category = b.categories.find((c) => c.id === payId("Master"))!;
    expect(cardAccountForCategory(b, category)?.id).toBe("Master");
  });

  it("falls back to the only card when the category name drifted", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa"] }).build();
    const category = { ...b.categories.find((c) => c.id === payId("Visa"))!, name: "Renamed" };
    expect(cardAccountForCategory(b, category)?.id).toBe("Visa");
  });

  it("does not guess between several cards (P8: pairs only when one card and one category are left)", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa", "Master"] }).build();
    for (const c of b.categories) c.name = `Renamed ${c.id}`;
    const category = b.categories.find((c) => c.id === payId("Visa"))!;
    expect(cardAccountForCategory(b, category)).toBeUndefined();
  });

  it("a card is an on-budget CREDIT-group account, as the engine sees it", () => {
    const b = scenario({ cash: ["Checking"], cards: ["Visa"], offBudget: ["Tracked"] }).build();
    const [checking, visa, tracked] = b.accounts;
    expect(isCardAccount(checking)).toBe(false);
    expect(isCardAccount(visa)).toBe(true);
    expect(isCardAccount(tracked)).toBe(false);
    // type "credit" alone does not make a card: the CREDIT group and on-budget do.
    expect(isCardAccount({ ...visa, group: "CASH" })).toBe(false);
    expect(isCardAccount({ ...visa, onBudget: false })).toBe(false);
    // ...and a credit-group account of another type does (a line of credit).
    const lineOfCredit = { ...visa, type: "checking" as const };
    expect(isCardAccount(lineOfCredit)).toBe(true);
  });
});
