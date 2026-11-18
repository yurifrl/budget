/**
 * planEdits — session-scoped undo/redo history for Plan assignment edits
 * (fixture syscd-app-ijn: YNAB-parity topbar undo/redo + Recent Moves).
 *
 * Every recorded edit is a self-contained before/after snapshot of the touched
 * categories' absolute assigned cents. Server assignment rows are absolute
 * upserts, so a snapshot IS its own inverse: undo re-applies `before`, redo
 * re-applies `after`. Snapshots are captured by the caller from the budget
 * aggregate right before persisting; the stack lives in the ephemeral
 * `budgetUi` slice and is cleared on budget switch — never persisted (design
 * D3: server data lives in budgetApi, derived values in the engine).
 *
 * History model: `past` is oldest → newest; `future` holds undone entries
 * oldest → newest, so undo/redo are simple stack pops. Reverting from the
 * Recent Moves list applies a move's before-values and moves it to the end of
 * `future` (so a following redo re-applies it), mirroring YNAB.
 */

import type { AutoAssignRow } from '../domain/auto-assign';
import { assignedInMonth } from '../domain/engine';
import { DEFAULT_MONEY_FORMAT, type MoneyFormat } from '../domain/format';
import { multiMoveMoneyUpdates, type MovePair } from '../data/ledger';
import type { Budget, Cents, MonthKey } from '../domain/types';
import { BUDGET_UI_KEY } from './keys';
import type { BudgetUiRootState } from './ui';

/** Stack depth cap — YNAB keeps a bounded recent-history too. */
export const PLAN_EDIT_HISTORY_LIMIT = 50;

/** How many entries the Recent Moves panel lists (most recent first). */
export const RECENT_MOVES_LIMIT = 10;

const RTA_LABEL = 'Ready to Assign';

export type PlanEditKind = 'assign' | 'move' | 'auto-assign';

/** One category's absolute assigned cents before and after the edit. */
export interface PlanEditUpdate {
  categoryId: string;
  categoryName: string;
  before: Cents;
  after: Cents;
}

/** Caller-provided edit (without bookkeeping fields). */
export interface PlanEditDraft {
  kind: PlanEditKind;
  budgetId: string;
  month: MonthKey;
  /** Display label for the Recent Moves list. */
  label: string;
  updates: PlanEditUpdate[];
}

export interface PlanEditEntry extends PlanEditDraft {
  id: string;
  /** Epoch ms when the edit was persisted. */
  at: number;
}

export interface PlanEditsState {
  /** Applied edits, oldest → newest. */
  past: PlanEditEntry[];
  /** Undone edits, oldest → newest (redo pops the end). */
  future: PlanEditEntry[];
}

export function initialPlanEdits(): PlanEditsState {
  return { past: [], future: [] };
}

let planEditSeq = 0;

/** Wrap a caller draft into a full history entry with id + timestamp. */
export function newPlanEdit(draft: PlanEditDraft, now = Date.now()): PlanEditEntry {
  planEditSeq += 1;
  return { ...draft, id: `pe-${now.toString(36)}-${planEditSeq}`, at: now };
}

/**
 * Append an applied edit. A new edit chained onto the top entry (same budget +
 * month, same category) inherits its `after` as `before` — the caller's
 * snapshot can be stale when edits land faster than the refetch — and a
 * fully-null edit is dropped. Any new edit truncates the redo stack.
 */
export function pushPlanEdit(state: PlanEditsState, entry: PlanEditEntry): void {
  const top = state.past[state.past.length - 1];
  const updates = entry.updates.map((u) => {
    if (!top || top.budgetId !== entry.budgetId || top.month !== entry.month) return u;
    const chained = top.updates.find((t) => t.categoryId === u.categoryId);
    return chained ? { ...u, before: chained.after } : u;
  });
  if (updates.length === 0 || updates.every((u) => u.before === u.after)) return;
  state.past.push({ ...entry, updates });
  if (state.past.length > PLAN_EDIT_HISTORY_LIMIT) state.past.shift();
  state.future = [];
}

/** Undo bookkeeping: the newest applied edit becomes redoable. */
export function movePlanEditToFuture(state: PlanEditsState): void {
  const entry = state.past.pop();
  if (entry) state.future.push(entry);
}

/** Redo bookkeeping (and undo-failure rollback): the newest undone edit reapplies. */
export function movePlanEditToPast(state: PlanEditsState): void {
  const entry = state.future.pop();
  if (entry) state.past.push(entry);
}

/** Revert bookkeeping: the move leaves its history position and becomes redoable. */
export function movePlanEditRevertToFuture(state: PlanEditsState, id: string): void {
  const idx = state.past.findIndex((e) => e.id === id);
  if (idx === -1) return;
  const [entry] = state.past.splice(idx, 1);
  state.future.push(entry);
}

/** Draft for a single category's inline assigned edit; null when nothing changes. */
export function makeAssignEdit(
  budget: Budget,
  budgetId: string,
  month: MonthKey,
  categoryId: string,
  nextCents: Cents,
  { formatMoney }: Pick<MoneyFormat, 'formatMoney'> = DEFAULT_MONEY_FORMAT,
): PlanEditDraft | null {
  const cat = budget.categories.find((c) => c.id === categoryId);
  if (!cat) return null;
  const before = assignedInMonth(cat, month);
  if (before === nextCents) return null;
  // "+R$ 50,00" for positive deltas, formatMoney's own sign otherwise.
  const delta = nextCents - before;
  return {
    kind: 'assign',
    budgetId,
    month,
    label: `Assign ${delta > 0 ? `+${formatMoney(delta)}` : formatMoney(delta)} · ${cat.name}`,
    updates: [{ categoryId, categoryName: cat.name, before, after: nextCents }],
  };
}

/**
 * Draft for a move-money edit of one or many pairs (see ledger.multiMoveMoneyUpdates
 * for the resulting absolute values); null when every pair is a no-op. One undo
 * step covers the whole multi-pair move. Ready-to-Assign endpoints are
 * label-only — RTA is derived, so only category rows enter the snapshot.
 */
export function makeMultiMoveEdit(
  budget: Budget,
  budgetId: string,
  month: MonthKey,
  pairs: readonly MovePair[],
  { formatMoney }: Pick<MoneyFormat, 'formatMoney'> = DEFAULT_MONEY_FORMAT,
): PlanEditDraft | null {
  const clean = pairs.filter((p) => p.amount > 0);
  if (clean.length === 0) return null;
  const updates = multiMoveMoneyUpdates(budget, month, clean);
  if (updates.length === 0) return null;
  const nameOf = (id: string | null) =>
    id === null ? RTA_LABEL : (budget.categories.find((c) => c.id === id)?.name ?? id);
  const total = clean.reduce((sum, p) => sum + p.amount, 0);
  const side = (end: 'from' | 'to') =>
    [...new Set(clean.map((p) => nameOf(p[end])))].join(', ');
  const label =
    clean.length === 1
      ? `Move ${formatMoney(total)} · ${nameOf(clean[0].from)} → ${nameOf(clean[0].to)}`
      : `Move ${formatMoney(total)} · ${side('from')} → ${side('to')}`;
  return {
    kind: 'move',
    budgetId,
    month,
    label,
    updates: updates.map((u) => {
      const cat = budget.categories.find((c) => c.id === u.categoryId);
      return {
        categoryId: u.categoryId,
        categoryName: cat?.name ?? u.categoryId,
        before: cat ? assignedInMonth(cat, month) : 0,
        after: u.assignedCents,
      };
    }),
  };
}

/** Single-pair convenience wrapper over makeMultiMoveEdit. */
export function makeMoveEdit(
  budget: Budget,
  budgetId: string,
  month: MonthKey,
  from: string | null,
  to: string | null,
  amount: Cents,
): PlanEditDraft | null {
  return makeMultiMoveEdit(budget, budgetId, month, [{ from, to, amount }]);
}

/** Draft for an auto-assign strategy; rows the strategy wouldn't change are dropped. */
export function makeAutoAssignEdit(
  budget: Budget,
  budgetId: string,
  month: MonthKey,
  rows: readonly AutoAssignRow[],
  strategyLabel: string,
): PlanEditDraft | null {
  const updates: PlanEditUpdate[] = [];
  for (const row of rows) {
    const cat = budget.categories.find((c) => c.id === row.categoryId);
    if (!cat) continue;
    const before = assignedInMonth(cat, month);
    if (before === row.assignCents) continue;
    updates.push({ categoryId: cat.id, categoryName: cat.name, before, after: row.assignCents });
  }
  if (updates.length === 0) return null;
  return {
    kind: 'auto-assign',
    budgetId,
    month,
    label: `${strategyLabel} · ${updates.length} ${updates.length === 1 ? 'category' : 'categories'}`,
    updates,
  };
}

/** Relative age for the Recent Moves list ("agora", "3m", "2h", "5d"). */
export function formatPlanEditAge(at: number, now = Date.now()): string {
  const secs = Math.max(0, Math.round((now - at) / 1000));
  if (secs < 60) return 'agora';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export const selectPlanEdits = (s: BudgetUiRootState): PlanEditsState => s[BUDGET_UI_KEY].planEdits;

/** Most-recent-first list for the Recent Moves panel. */
let recentCache: { past: PlanEditEntry[]; result: PlanEditEntry[] } | null = null;
export const selectRecentPlanEdits = (s: BudgetUiRootState): PlanEditEntry[] => {
  const past = s[BUDGET_UI_KEY].planEdits.past;
  // Memoized on `past` identity so useSelector gets a stable reference.
  if (recentCache?.past !== past) {
    recentCache = { past, result: [...past].slice(-RECENT_MOVES_LIMIT).reverse() };
  }
  return recentCache.result;
};
