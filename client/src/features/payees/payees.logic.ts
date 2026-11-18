/**
 * Pure rules of the Manage Payees screen: list filtering, merge candidates,
 * what a rename / renaming-rule commit actually sends, and the small view
 * strings. Wire-typed (PayeeAdminRow), so it lives beside the screen rather
 * than in domain/.
 */

import { matchTypeLabels, matchTypes, type MatchType } from '@shared/domain/payees';

import type { PayeeAdminRow } from '@/budget/data/rows';

/** Unsaved renaming-rule edit of the selected payee. */
export interface RuleDraft {
  matchType: MatchType;
  condition: string;
}

/**
 * Case-insensitive name search. Hidden payees stay listed (grey) so they can
 * be found and unhidden; transfer payees are excluded server-side.
 */
export function filterPayees<T extends { name: string }>(all: T[], search: string): T[] {
  const q = search.trim().toLowerCase();
  return all.filter((p) => !q || p.name.toLowerCase().includes(q));
}

/** Merge targets: other live, non-transfer payees in the budget. */
export function mergeCandidatesFor(all: PayeeAdminRow[], selected: PayeeAdminRow | null): PayeeAdminRow[] {
  return selected ? all.filter((p) => p.id !== selected.id && !p.deleted && p.transfer_account_id === null) : [];
}

type RuleFields = Pick<PayeeAdminRow, 'rename_match_type' | 'rename_condition'>;

/** The payee's stored renaming rule; no rule reads as an empty Contains. */
export function savedRule(payee: RuleFields): RuleDraft {
  return {
    matchType: payee.rename_match_type ?? 'contains',
    condition: payee.rename_condition ?? '',
  };
}

/**
 * The rule a commit would save: draft (else the saved rule) overlaid with
 * `patch`, condition trimmed. Null when that equals the saved rule (nothing
 * to send; the caller just drops the draft). An empty condition clears the
 * rule server-side.
 */
export function ruleToSave(draft: RuleDraft | null, payee: RuleFields, patch?: Partial<RuleDraft>): RuleDraft | null {
  const saved = savedRule(payee);
  const next = { ...(draft ?? saved), ...patch };
  const condition = next.condition.trim();
  if (condition === saved.condition && next.matchType === saved.matchType) return null;
  return { matchType: next.matchType, condition };
}

/** The name a rename commit sends, or null when there is nothing to rename. */
export function renameToCommit(draft: string | null, currentName: string): string | null {
  if (draft == null) return null;
  const name = draft.trim();
  if (!name || name === currentName) return null;
  return name;
}

/**
 * Matcher is pick-only: a typed label is adopted only when it matches one
 * exactly (case-insensitive, trimmed).
 */
export function matchTypeFromLabel(text: string): MatchType | undefined {
  return matchTypes.find((m) => matchTypeLabels[m].toLowerCase() === text.trim().toLowerCase());
}

/** "3 transactions · last used 2026-01-02" / "0 transactions · never used". */
export function activityLine(payee: Pick<PayeeAdminRow, 'transaction_count' | 'last_used_date'>): string {
  const count = `${payee.transaction_count} transaction${payee.transaction_count === 1 ? '' : 's'}`;
  return count + (payee.last_used_date ? ` · last used ${payee.last_used_date.slice(0, 10)}` : ' · never used');
}

/** Pages of a paginated table; an empty table still has page 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
