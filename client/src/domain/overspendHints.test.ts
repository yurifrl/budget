import { describe, expect, it } from "bun:test";

import { creditOverspendHint, overspendHint, underfundedHint } from "./overspendHints";
import type { MonthKey } from "./types";
import { computeBudgetMonth } from "./zeroSum";
import { dateIn, payId, scenario } from "./__fixtures__/zeroSum.fixtures";

const JUN: MonthKey = 202606;
const nb = (s: string) => s.replace(/ /g, " ");

const base = () =>
  scenario({ cash: ["Checking"], cards: ["Card"], categories: ["c"] }).startingBalance("Checking", 2_000_000, dateIn(202605, 1));

describe("underfundedHint", () => {
  it("labels a card payment category whose debt is not covered", () => {
    const b = base().startingBalance("Card", -75369, dateIn(202605, 1)).build();
    const hint = underfundedHint(computeBudgetMonth(b, JUN), payId("Card"));
    expect(nb(hint?.label ?? "")).toBe("Underfunded R$ 753,69");
    expect(hint?.detail).toContain("753,69");
  });

  it("is null once the envelope covers the debt, and for spending categories", () => {
    const b = base().startingBalance("Card", -10000, dateIn(202605, 1)).assign(payId("Card"), JUN, 10000).build();
    const bm = computeBudgetMonth(b, JUN);
    expect(underfundedHint(bm, payId("Card"))).toBeNull();
    expect(underfundedHint(bm, "c")).toBeNull();
  });
});

describe("creditOverspendHint", () => {
  it("describes a category overspent on credit only", () => {
    const b = base().spend("Card", "c", 4000, dateIn(JUN, 10)).build();
    const bm = computeBudgetMonth(b, JUN);
    const hint = creditOverspendHint(bm, "c");
    expect(nb(hint?.label ?? "")).toBe("R$ 40,00 on credit");
    expect(nb(hint?.detail ?? "")).toBe("R$ 40,00 spent on credit with no money assigned: added to card debt");
    expect(overspendHint(bm, "c")).toEqual(hint);
  });

  it("is null for cash overspend and for covered credit spending", () => {
    const cash = base().spend("Checking", "c", 4000, dateIn(JUN, 10)).build();
    expect(creditOverspendHint(computeBudgetMonth(cash, JUN), "c")).toBeNull();
    const covered = base().assign("c", JUN, 5000).spend("Card", "c", 4000, dateIn(JUN, 10)).build();
    expect(overspendHint(computeBudgetMonth(covered, JUN), "c")).toBeNull();
  });
});
