/**
 * Moving money to and from a credit card payment category (docs/budget-engine-spec.md
 * section 3, R2). Moved out of domain/payments.test.ts because it exercises
 * data/ledger's moveMoneyUpdates (domain/ may import only itself).
 */

import { describe, expect, it } from "bun:test";
import { moveMoneyUpdates } from "../data/ledger";
import type { AssignmentUpdate } from "../data/ledger";
import type { Budget, MonthKey } from "../domain/types";
import { computeBudgetMonth } from "../domain/zeroSum";
import { dateIn, payId, scenario, type Scenario } from "../domain/__fixtures__/zeroSum.fixtures";

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

describe("moving money to and from a payment category conserves money (R2)", () => {
  const withAssigned = (b: Budget, updates: AssignmentUpdate[]): Budget => ({
    ...b,
    categories: b.categories.map((c) => {
      const u = updates.find((x) => x.categoryId === c.id);
      return u ? { ...c, assigned: { ...c.assigned, [JUN]: u.assignedCents } } : c;
    }),
  });
  const debtBudget = () => base().startingBalance("Card", -8759990, dateIn(202605, 1)).build();

  it("a move out lowers Available by exactly what Ready to Assign gains", () => {
    const before = debtBudget();
    const rtaBefore = computeBudgetMonth(before, JUN).readyToAssign;
    expect(pay(before).available).toBe(0); // P3: starting debt is not funded

    const updates = moveMoneyUpdates(before, JUN, PAY, null, 8759990);
    const after = withAssigned(before, updates);
    expect(pay(after).available).toBe(-8759990);
    expect(computeBudgetMonth(after, JUN).readyToAssign - rtaBefore).toBe(8759990);
  });

  it("a move in raises Available by exactly what Ready to Assign loses", () => {
    const before = debtBudget();
    const rtaBefore = computeBudgetMonth(before, JUN).readyToAssign;
    const after = withAssigned(before, moveMoneyUpdates(before, JUN, null, PAY, 300000));
    expect(pay(after).available).toBe(300000);
    expect(computeBudgetMonth(after, JUN).readyToAssign - rtaBefore).toBe(-300000);
  });
});
