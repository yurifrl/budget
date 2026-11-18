import { describe, it, expect } from "bun:test";
import { applyRules, matchRule, suggestCategory, type CategorizationHistoryRow, type RenameRule } from "./payees";

const AUTO = { categorization_mode: "auto", default_category_id: null } as const;
const fixed = (default_category_id: string | null) => ({
  categorization_mode: "fixed",
  default_category_id,
}) as const;
const NEVER = { categorization_mode: "never", default_category_id: null } as const;

const rows = (...specs: [string, string | null][]): CategorizationHistoryRow[] =>
  specs.map(([date, category_id]) => ({ date, category_id }));

describe("suggestCategory", () => {
  it("auto: picks the most-used past category", () => {
    const history = rows(
      ["2026-01-01", "cat-a"],
      ["2026-02-01", "cat-b"],
      ["2026-03-01", "cat-b"],
    );
    expect(suggestCategory(AUTO, history, "auto")).toBe("cat-b");
  });

  it("auto: breaks count ties by most recent use", () => {
    const history = rows(
      ["2026-01-10", "cat-a"],
      ["2026-02-01", "cat-b"],
      ["2026-02-05", "cat-a"],
      ["2026-01-20", "cat-b"],
    );
    expect(suggestCategory(AUTO, history, "auto")).toBe("cat-a");
  });

  it("auto: fully tied counts and dates resolve deterministically", () => {
    const history = rows(
      ["2026-02-01", "cat-b"],
      ["2026-02-01", "cat-a"],
    );
    expect(suggestCategory(AUTO, history, "auto")).toBe("cat-a");
  });

  it("auto: uncategorized history rows are ignored", () => {
    const history = rows(
      ["2026-01-01", null],
      ["2026-02-01", null],
    );
    expect(suggestCategory(AUTO, history, "auto")).toBeNull();
  });

  it("auto: no history invents nothing", () => {
    expect(suggestCategory(AUTO, [], "auto")).toBeNull();
  });

  it("auto: ignores the payee default (history-driven only)", () => {
    expect(suggestCategory({ ...AUTO, default_category_id: "cat-d" }, rows(["2026-01-01", null]), "auto")).toBeNull();
  });

  it("fixed: always uses the default category, history notwithstanding", () => {
    const history = rows(["2026-01-01", "cat-a"], ["2026-02-01", "cat-a"]);
    expect(suggestCategory(fixed("cat-d"), history, "fixed")).toBe("cat-d");
  });

  it("fixed: without a default suggests nothing", () => {
    expect(suggestCategory(fixed(null), rows(["2026-01-01", "cat-a"]), "fixed")).toBeNull();
  });

  it("never: suggests nothing even with history", () => {
    expect(suggestCategory(NEVER, rows(["2026-01-01", "cat-a"]), "never")).toBeNull();
  });
});

const rule = (condition: string, match_type: RenameRule["match_type"], replacement: string): RenameRule => ({
  condition,
  match_type,
  replacement,
});

describe("matchRule / applyRules", () => {
  it("contains: fires on substring, case-insensitively", () => {
    expect(matchRule(rule("coffee", "contains", "Blue Bottle"), "SQ *Blue Bottle Coffee")).toBe(true);
    expect(matchRule(rule("coffee", "contains", "Blue Bottle"), "SQ *Café")).toBe(false);
  });

  it("contains: never fires on an empty condition", () => {
    expect(matchRule(rule("", "contains", "Blue Bottle"), "anything")).toBe(false);
  });

  it("is: fires only on an exact, case-insensitive match", () => {
    expect(matchRule(rule("padaria", "is", "Padaria do Zé"), "PADARIA")).toBe(true);
    expect(matchRule(rule("padaria", "is", "Padaria do Zé"), "padaria do zé")).toBe(false);
  });

  it("contains: replaces every occurrence and trims", () => {
    expect(applyRules([rule("sq *", "contains", "")], "SQ *BLUE SQ *BOTTLE")).toBe("blue bottle");
  });

  it("is: the whole name becomes the target payee's name", () => {
    expect(applyRules([rule("netflix.com", "is", "Netflix")], "NETFLIX.COM")).toBe("Netflix");
  });

  it("the first matching rule wins and later rules don't reapply", () => {
    expect(applyRules([rule("a", "contains", "B"), rule("b", "contains", "C")], "aaa")).toBe("BBB");
  });

  it("no match leaves the name unchanged", () => {
    expect(applyRules([rule("x", "contains", "Y")], "padaria")).toBe("padaria");
  });
});
