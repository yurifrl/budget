import { describe, it, expect } from "bun:test";
import { applyRules, findRenameRule, matchRule, normalizeRuleText, suggestCategory, type CategorizationHistoryRow, type RenameRule } from "./payees";

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

describe("matchRule", () => {
  it("contains: fires on substring, case-insensitively", () => {
    expect(matchRule(rule("coffee", "contains", "Blue Bottle"), "SQ *Blue Bottle Coffee")).toBe(true);
    expect(matchRule(rule("coffee", "contains", "Blue Bottle"), "SQ *Café")).toBe(false);
  });

  it("never fires on an empty or blank condition", () => {
    expect(matchRule(rule("", "contains", "Blue Bottle"), "anything")).toBe(false);
    expect(matchRule(rule("   ", "is", "Blue Bottle"), "anything")).toBe(false);
    expect(matchRule(rule("", "starts_with", "Blue Bottle"), "anything")).toBe(false);
    expect(matchRule(rule("", "ends_with", "Blue Bottle"), "anything")).toBe(false);
  });

  it("is: fires only on an exact, case-insensitive match", () => {
    expect(matchRule(rule("padaria", "is", "Padaria do Zé"), "PADARIA")).toBe(true);
    expect(matchRule(rule("padaria", "is", "Padaria do Zé"), "padaria do zé")).toBe(false);
  });

  it("starts with / ends with anchor the pattern", () => {
    expect(matchRule(rule("pix ", "starts_with", "X"), "PIX SAVINGS 42")).toBe(true);
    expect(matchRule(rule("pix", "starts_with", "X"), "SAVINGS PIX")).toBe(false);
    expect(matchRule(rule("savings 42", "ends_with", "X"), "PIX SAVINGS 42")).toBe(true);
    expect(matchRule(rule("savings", "ends_with", "X"), "PIX SAVINGS 42")).toBe(false);
  });

  it("compares exactly as main did: lower case only, spaces are significant, nothing is trimmed or collapsed", () => {
    expect(matchRule(rule("pix savings", "is", "X"), "PIX SAVINGS")).toBe(true);
    expect(matchRule(rule("pix  savings", "is", "X"), "PIX SAVINGS")).toBe(false);
    expect(matchRule(rule("pix savings", "is", "X"), "PIX  SAVINGS")).toBe(false);
    expect(matchRule(rule("pix savings", "contains", "X"), "TED  PIX    SAVINGS 42")).toBe(false);
    expect(matchRule(rule("pix  savings", "contains", "X"), "TED PIX  SAVINGS 42")).toBe(true);
    expect(matchRule(rule("pix", "is", "X"), " PIX ")).toBe(false);
    expect(matchRule(rule("pix", "starts_with", "X"), " PIX 1")).toBe(false);
    expect(normalizeRuleText("  A   b\n C ")).toBe("  a   b\n c ");
  });

  it("accents are significant (as before): no folding", () => {
    expect(matchRule(rule("padaria pão", "contains", "X"), "PADARIA PAO")).toBe(false);
    expect(matchRule(rule("padaria pão", "contains", "X"), "PADARIA PÃO 1")).toBe(true);
  });
});

describe("findRenameRule / applyRules", () => {
  const r = (condition: string, match_type: RenameRule["match_type"], replacement: string) => rule(condition, match_type, replacement);

  it("a matching rule assigns the payee itself: the rest of the text is not kept", () => {
    expect(applyRules([r("pix savings", "contains", "Transfer : Savings")], "PIX SAVINGS 42")).toBe("Transfer : Savings");
    expect(applyRules([r("sq *", "contains", "Blue Bottle")], "SQ *BLUE SQ *BOTTLE")).toBe("Blue Bottle");
    expect(applyRules([r("netflix.com", "is", "Netflix")], "NETFLIX.COM")).toBe("Netflix");
    expect(applyRules([r("uber", "starts_with", "Uber")], "UBER *TRIP 123")).toBe("Uber");
    expect(applyRules([r("trip 123", "ends_with", "Uber")], "UBER *TRIP 123")).toBe("Uber");
  });

  it("no match leaves the name unchanged", () => {
    expect(applyRules([r("x", "contains", "Y")], "padaria")).toBe("padaria");
    expect(applyRules([], "padaria")).toBe("padaria");
  });

  it("several rules of several payees: is, then starts/ends with, then contains", () => {
    const rules = [
      r("pix", "contains", "Contains"),
      r("pix savings 42", "ends_with", "Ends"),
      r("pix savings 42", "is", "Is"),
      r("pix sav", "starts_with", "Starts"),
    ];
    expect(findRenameRule(rules, "PIX SAVINGS 42")?.replacement).toBe("Is");
    expect(findRenameRule(rules.filter((x) => x.replacement !== "Is"), "PIX SAVINGS 42")?.replacement).toBe("Ends");
    expect(findRenameRule(rules.filter((x) => x.match_type === "contains"), "PIX SAVINGS 42")?.replacement).toBe("Contains");
  });

  it("within a rank the longest pattern wins, then the earliest rule", () => {
    const rules = [r("pix", "contains", "Short"), r("pix savings", "contains", "Long"), r("savings 42", "contains", "Long2")];
    expect(findRenameRule(rules, "PIX SAVINGS 42")?.replacement).toBe("Long");
    expect(findRenameRule([r("ab", "contains", "First"), r("ab", "contains", "Second")], "xaby")?.replacement).toBe("First");
    // starts with and ends with share a rank: the longer pattern, then the earlier rule.
    expect(findRenameRule([r("pix", "starts_with", "S"), r("x 42", "ends_with", "E")], "PIX 42")?.replacement).toBe("E");
    expect(findRenameRule([r("pi", "starts_with", "S"), r("42", "ends_with", "E")], "PIX 42")?.replacement).toBe("S");
    expect(findRenameRule([r("42", "ends_with", "E"), r("pi", "starts_with", "S")], "PIX 42")?.replacement).toBe("E");
    expect(findRenameRule([r("pix", "starts_with", "S"), r("x 42", "ends_with", "E")], "PIX 42")?.replacement).toBe("E");
  });

  it("the result does not depend on the case of a rule or of the text", () => {
    expect(findRenameRule([r("PIX Savings", "contains", "A")], "pix savings 1")?.replacement).toBe("A");
    expect(findRenameRule([r("pix savings", "contains", "A")], "PIX SAVINGS 1")?.replacement).toBe("A");
  });
});
