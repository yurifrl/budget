/**
 * Budget change-revision watcher — the pure decision. The server bumps a
 * per-budget revision on ANY write to the budget's data (GET /budget-revision);
 * the client polls it and invalidates the budget's cached data when it moves.
 * The first value seen only establishes the baseline: it must not refetch.
 */

export interface RevisionDecision {
  /** Revision to remember for the next comparison. */
  last: number;
  /** True when cached data for the budget is stale. */
  invalidate: boolean;
}

export function decideRevision(last: number | null, next: number): RevisionDecision {
  if (last === null) return { last: next, invalidate: false };
  return { last: next, invalidate: next !== last };
}

/** Every budget-scoped tag type (id = budget id) to invalidate on a revision change. */
export const BUDGET_DATA_TAGS = [
  'Groups',
  'Categories',
  'Bundles',
  'Accounts',
  'Transactions',
  'Assignments',
  'MonthNotes',
  'Payees',
  'Targets',
  'CategoryNotes',
  'Members',
  'Categorize',
] as const;

/** Poll cadence while the app is in the foreground (ms). */
export const REVISION_POLL_MS = 10_000;
