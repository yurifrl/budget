import { describe, it, expect } from "bun:test";
import { assocRules, makeDraftRows } from "./assoc";
import type { PayeeRow } from "../data/rows";
import type { ImportParseResult } from "./types";

const parsed: ImportParseResult = {
  rows: [
    { date: "2026-10-01", payee: "NETFLIX.COM", memo: "", outflowCents: 5590, inflowCents: 0 },
    { date: "2026-10-02", payee: "padaria", memo: "coffee", outflowCents: 1250, inflowCents: 0 },
  ],
  skipped: 1,
  errors: [],
};

const payee = (id: string, name: string): PayeeRow => ({
  id,
  name,
  transfer_account_id: null,
  deleted: false,
});

describe("makeDraftRows", () => {
  it("wraps every parsed row as an included draft with its statement payee as original", () => {
    const drafts = makeDraftRows(parsed.rows);
    expect(drafts).toHaveLength(2);
    expect(drafts[0]).toMatchObject({
      date: "2026-10-01",
      payee: "NETFLIX.COM",
      originalPayee: "NETFLIX.COM",
      payeeId: null,
      included: true,
    });
  });

  it("carries the parser's import id for dedupe", () => {
    const withIds: ImportParseResult = {
      ...parsed,
      rows: [{ ...parsed.rows[0], importId: "nubank:42:2026-10-01:-5590" } as never],
    };
    expect(makeDraftRows(withIds.rows)[0].importId).toBe("nubank:42:2026-10-01:-5590");
  });

  it("auto-selects a budget payee whose name case-insensitively matches the statement text", () => {
    const drafts = makeDraftRows(parsed.rows, [
      payee("p1", "Netflix"),
      payee("p2", "Padaria do Zé"),
    ]);
    expect(drafts[0].payeeId).toBe("p1");
    // No whitespace-insensitive partial match: 'padaria' ≠ 'Padaria do Zé'.
    expect(drafts[1].payeeId).toBe(null);
  });

  it("prefers the first payee on duplicate names and ignores blank names", () => {
    const drafts = makeDraftRows(parsed.rows, [
      payee("p1", " netflix.com "),
      payee("p2", "Netflix.com"),
      payee("p3", "   "),
    ]);
    expect(drafts[0].payeeId).toBe("p1");
  });
});

describe("assocRules", () => {
  it("maps statement text to the chosen payee's name", () => {
    const drafts = makeDraftRows(parsed.rows);
    drafts[0].payeeId = "p1";
    const rules = assocRules(drafts, new Map([["p1", payee("p1", "Netflix")]]));
    expect(rules).toEqual([{ payeeId: "p1", condition: "NETFLIX.COM", replacement: "Netflix" }]);
  });

  it("skips rows without an association and no-op matches", () => {
    const drafts = makeDraftRows(parsed.rows);
    drafts[0].payeeId = "p1";
    drafts[1].payeeId = null;
    const rules = assocRules(drafts, new Map([["p1", payee("p1", "NETFLIX.COM")]]));
    expect(rules).toEqual([]);
  });

  it("collapses repeated statement payees to one rule", () => {
    const repeated: ImportParseResult = {
      rows: [parsed.rows[0], { ...parsed.rows[0], date: "2026-10-15" }],
      skipped: 0,
      errors: [],
    };
    const drafts = makeDraftRows(repeated.rows);
    drafts[0].payeeId = "p1";
    drafts[1].payeeId = "p1";
    const rules = assocRules(drafts, new Map([["p1", payee("p1", "Netflix")]]));
    expect(rules).toEqual([{ payeeId: "p1", condition: "NETFLIX.COM", replacement: "Netflix" }]);
  });

  it("drops conflicting associations for the same statement text", () => {
    const drafts = makeDraftRows(parsed.rows);
    drafts[0].payeeId = "p1";
    drafts[1].payeeId = "p2";
    drafts[1].originalPayee = "NETFLIX.COM";
    drafts[1].payee = "NETFLIX.COM";
    const rules = assocRules(
      drafts,
      new Map([
        ["p1", payee("p1", "Netflix")],
        ["p2", payee("p2", "Netflix Brasil")],
      ]),
    );
    expect(rules).toEqual([]);
  });

  it("drops a payee whose rows carry two different statement texts (one rule per payee)", () => {
    const drafts = makeDraftRows(parsed.rows);
    drafts[0].payeeId = "p1";
    drafts[1].payeeId = "p1";
    const rules = assocRules(drafts, new Map([["p1", payee("p1", "Netflix")]]));
    expect(rules).toEqual([]);
  });
});
