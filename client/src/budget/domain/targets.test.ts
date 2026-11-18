import { describe, it, expect } from "bun:test";
import { neededBy, suggestedToAssign, targetBadge, targetDueDay } from "./targets";
import type { CategoryTarget } from "./types";

const M: Record<string, number> = {
  aug: 202608,
  sep: 202609,
  oct: 202610,
  nov: 202611,
  dec: 202612,
  jan: 202701,
};

/** Target factory with sensible defaults for focused unit tests. */
function target(partial: Partial<CategoryTarget>): CategoryTarget {
  return {
    categoryId: partial.categoryId ?? "c1",
    kind: partial.kind ?? "monthly",
    amountCents: partial.amountCents ?? 50000,
    snoozeMonth: partial.snoozeMonth,
    config: partial.config ?? {},
  };
}

describe("neededBy", () => {
  it("weekly: per-week amount times target weekdays in the month", () => {
    // Sep 2026 has 4 Mondays; Aug 2026 has 5.
    const t = target({ kind: "weekly", amountCents: 10000, config: { dayOfWeek: 1 } });
    expect(neededBy(t, M.sep)).toBe(40000);
    expect(neededBy(t, M.aug)).toBe(50000);
  });

  it("monthly: full amount every month from the start month", () => {
    const t = target({ kind: "monthly", amountCents: 50000, config: { fromMonth: 202609 } });
    expect(neededBy(t, M.oct)).toBe(50000);
    expect(neededBy(t, 202608)).toBe(0);
  });

  it("snoozed month asks nothing; later months resume", () => {
    const t = target({ kind: "monthly", amountCents: 50000, snoozeMonth: M.oct });
    expect(neededBy(t, M.oct)).toBe(0);
    expect(neededBy(t, M.nov)).toBe(50000);
  });

  it("yearly: full amount in the due month, split before it", () => {
    const t = target({
      kind: "yearly",
      amountCents: 120000,
      config: { monthOfYear: 12, dayOfMonth: 1 },
    });
    expect(neededBy(t, M.dec)).toBe(120000);
    expect(neededBy(t, M.sep)).toBe(30000); // 4 months until Dec
    expect(neededBy(t, M.jan)).toBe(10000); // next cycle, 12 months out
  });

  it("custom: spreads over start-to-due months, 0 after", () => {
    const t = target({
      kind: "custom",
      amountCents: 60000,
      config: { byDate: "2026-12-15", fromMonth: 202609 },
    });
    expect(neededBy(t, M.sep)).toBe(15000);
    expect(neededBy(t, M.dec)).toBe(15000);
    expect(neededBy(t, M.jan)).toBe(0);
  });

  it("custom without a start month asks the full amount until the due date", () => {
    const t = target({ kind: "custom", amountCents: 60000, config: { byDate: "2026-12-15" } });
    expect(neededBy(t, M.oct)).toBe(60000);
    expect(neededBy(t, M.jan)).toBe(0);
  });

  it("weekly with repeatEvery N splits per-week amounts", () => {
    const t = target({
      kind: "weekly",
      amountCents: 10000,
      config: { dayOfWeek: 1, repeatEvery: 2 },
    });
    expect(neededBy(t, M.sep)).toBe(20000);
  });
});

describe("suggestedToAssign", () => {
  it("clamps to what is available to assign", () => {
    const t = target({ kind: "monthly", amountCents: 50000 });
    expect(suggestedToAssign(t, M.sep, 20000, 100000)).toBe(30000);
    expect(suggestedToAssign(t, M.sep, 20000, 10000)).toBe(10000);
  });

  it("is 0 once fully funded", () => {
    const t = target({ kind: "monthly", amountCents: 50000 });
    expect(suggestedToAssign(t, M.sep, 50000, 100000)).toBe(0);
  });
});

describe("targetBadge / targetDueDay", () => {
  it("funded state has no 'more' and no due label", () => {
    const t = target({ kind: "monthly", amountCents: 50000 });
    expect(targetBadge(t, M.sep, 50000)).toEqual({ state: "funded", more: 0, byLabel: null });
  });

  it("needed state carries the shortfall and due label", () => {
    const t = target({ kind: "monthly", amountCents: 50000 });
    const badge = targetBadge(t, M.sep, 20000);
    expect(badge.state).toBe("needed");
    expect(badge.more).toBe(30000);
    expect(badge.byLabel).not.toBeNull();
  });

  it("custom due day lands on the configured date", () => {
    const t = target({ kind: "custom", amountCents: 60000, config: { byDate: "2026-12-15" } });
    expect(targetDueDay(t, M.dec)).toBe(15);
  });
});

it("monthly ignores repeatEvery when unanchored (no fromMonth)", () => {
  const t = target({ kind: "monthly", amountCents: 50000, config: { repeatEvery: 2 } });
  expect(neededBy(t, M.sep)).toBe(50000);
});
