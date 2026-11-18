/**
 * Import-review model — pure, editable draft rows built from the parsed
 * statement plus payee association (statement text → budget payee) and its
 * persistence as 'contains' rename rules. No React, no fetch: the screen
 * (screens/ImportScreen) keeps state and renders.
 */

import type { PayeeRow } from '../data/rows';
import type { ImportRow } from '../domain/importTypes';

/**
 * One review row: a parsed statement row the user can edit in place, exclude,
 * or associate with an existing budget payee. `originalPayee` freezes the
 * statement text at parse time so association survives payee edits.
 */
export interface DraftImportRow extends ImportRow {
  /** Exact statement text at parse time — association anchor. */
  originalPayee: string;
  /** Chosen budget payee, null = keep the (possibly edited) statement text. */
  payeeId: string | null;
  /** Deterministic dedupe id (Nubank rows carry one); passthrough to the wire. */
  importId?: string | null;
  /** false = row stays in the review list but is not imported. */
  included: boolean;
}

/**
 * Wrap parsed rows into editable drafts. When `payees` is given, statement
 * text that case-insensitively equals a budget payee's name auto-selects that
 * payee (association only — rename rules stay user-driven).
 */
export function makeDraftRows(rows: ImportRow[], payees: readonly PayeeRow[] = []): DraftImportRow[] {
  const names = payees
    .map((p) => ({ id: p.id, name: p.name.trim().toLowerCase() }))
    .filter((p) => p.name);
  return rows.map((row) => {
    const text = row.payee.trim().toLowerCase();
    // YNAB-rule direction: the budget payee's name inside the statement text
    // ("NETFLIX.COM" binds "Netflix"); the reverse would mis-bind short
    // statements to long vendor names ('padaria' ≠ 'Padaria do Zé').
    const hit = names.find((p) => text.includes(p.name));
    return {
      ...row,
      originalPayee: row.payee,
      payeeId: hit?.id ?? null,
      included: true,
    };
  });
}

/**
 * One rename rule derived from an association: statement text matched against
 * the budget payee, whose own name is the rename target ('contains' matcher).
 */
export interface AssocRule {
  payeeId: string;
  condition: string;
  /** The payee's name — display only; the server stores the payee row's name. */
  replacement: string;
}

/**
 * Distinct per-payee conditions for the associated rows whose statement text
 * is neither empty nor already the payee's name — future imports of the same
 * statement text resolve automatically. One rule per payee: a payee whose
 * rows carry two different statement texts is ambiguous, and a statement text
 * claimed by two different payees is ambiguous too — no rule is saved for
 * either (the per-row association in this batch is unaffected).
 */
export function assocRules(
  rows: readonly DraftImportRow[],
  payeeById: ReadonlyMap<string, PayeeRow>,
): AssocRule[] {
  const wanted = new Map<string, string>(); // payeeId → statement text
  const contestedPayees = new Set<string>();
  for (const row of rows) {
    if (!row.included || row.payeeId == null || !row.originalPayee) continue;
    const payee = payeeById.get(row.payeeId);
    if (!payee || payee.name === row.originalPayee) continue;
    if (wanted.has(row.payeeId) && wanted.get(row.payeeId) !== row.originalPayee) {
      contestedPayees.add(row.payeeId);
    } else {
      wanted.set(row.payeeId, row.originalPayee);
    }
  }
  for (const payeeId of contestedPayees) wanted.delete(payeeId);

  // The condition column is unique per budget: text claimed by two payees
  // (or by a payee that already carries a different rule) is dropped here.
  const byCondition = new Map<string, string>(); // condition → payeeId
  const contestedConditions = new Set<string>();
  for (const [payeeId, condition] of wanted) {
    if (byCondition.has(condition) && byCondition.get(condition) !== payeeId) {
      contestedConditions.add(condition);
    } else {
      byCondition.set(condition, payeeId);
    }
  }
  for (const condition of contestedConditions) byCondition.delete(condition);
  return [...byCondition].map(([condition, payeeId]) => ({
    payeeId,
    condition,
    replacement: payeeById.get(payeeId)!.name,
  }));
}
