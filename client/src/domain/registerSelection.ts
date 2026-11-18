/**
 * Pure selection rules for the account register: the checked-id set
 * (toggle, shift-range, select all), the selection bar's derived flags and
 * the web keyboard shortcuts. The screen's hook (`useRegisterSelection`)
 * owns the state and the mutations; everything decidable lives here.
 */

import type { Account, Cents, ClearedStatus, Transaction } from './types';

type Row = Pick<Transaction, 'id'>;

/** Checkbox / ctrl-click: flip one id. */
export function toggleId(prev: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(prev);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/**
 * Shift-click (web, YNAB register): select everything between the anchor (the
 * last row the user clicked or toggled) and the clicked row, added to the
 * current selection. No anchor, or one that is no longer visible, ranges from
 * the first row.
 */
export function selectRange(
  prev: ReadonlySet<string>,
  rows: readonly Row[],
  anchorId: string | null,
  clickedId: string,
): Set<string> {
  const idx = rows.findIndex((r) => r.id === clickedId);
  const anchorIdx = anchorId ? rows.findIndex((r) => r.id === anchorId) : 0;
  const lo = Math.min(idx, Math.max(anchorIdx, 0));
  const hi = Math.max(idx, Math.max(anchorIdx, 0));
  const next = new Set(prev);
  for (let i = lo; i <= hi; i += 1) {
    const row = rows[i];
    if (row) next.add(row.id);
  }
  return next;
}

/** Header checkbox state: every visible register row is selected. */
export function allRowsSelected(rows: readonly Row[], selectedIds: ReadonlySet<string>): boolean {
  return rows.length > 0 && rows.every((t) => selectedIds.has(t.id));
}

/**
 * Select-all (syscd-app-vnwz): the header checkbox covers every visible
 * register row, reconciled included. Checking unions into the selection;
 * unchecking removes only the visible rows, keeping any hidden selections.
 */
export function toggleAllVisible(prev: ReadonlySet<string>, rows: readonly Row[], allSelected: boolean): Set<string> {
  const next = new Set(prev);
  if (allSelected) {
    for (const t of rows) next.delete(t.id);
  } else {
    for (const t of rows) next.add(t.id);
  }
  return next;
}

/** Mark-as label direction: an all-cleared selection flips to "Mark as Uncleared". */
export function selectionAllCleared(selected: readonly Pick<Transaction, 'cleared'>[]): boolean {
  return selected.length > 0 && selected.every((t) => t.cleared !== 'uncleared');
}

/**
 * More-menu Match enablement: exactly one selectable candidate pair (the
 * row-menu flow stays the multi-candidate picker). `candidatesOf` is the
 * register's match rule for a row.
 */
export function selectionCanMatch(
  selected: readonly Transaction[],
  candidatesOf: (t: Transaction) => readonly Row[],
): boolean {
  if (selected.length !== 2) return false;
  const [a, b] = selected;
  if (a.matchedTransactionId || b.matchedTransactionId) return false;
  return candidatesOf(a).some((c) => c.id === b.id);
}

/** Move-to targets: open accounts that none of the selected rows already sit in. */
export function selectionMoveTargets(
  accounts: readonly Account[],
  selected: readonly Pick<Transaction, 'accountId'>[],
): { id: string; name: string; disabled: boolean }[] {
  return accounts
    .filter((a) => a.group !== 'CLOSED' && selected.every((t) => t.accountId !== a.id))
    .map((a) => ({ id: a.id, name: a.name, disabled: false }));
}

/**
 * Ids whose match link Unmatch clears, in request order: each matched
 * selected row, then its partner unless the partner is selected itself (it
 * then clears on its own turn).
 */
export function unmatchTargets(
  selected: readonly Pick<Transaction, 'id' | 'matchedTransactionId'>[],
  selectedIds: ReadonlySet<string>,
): string[] {
  const out: string[] = [];
  for (const t of selected) {
    const other = t.matchedTransactionId;
    if (!other) continue;
    out.push(t.id);
    if (!selectedIds.has(other)) out.push(other);
  }
  return out;
}

/** The new-transaction fields Duplicate posts for a row. */
export function duplicateDraft(t: Transaction): {
  accountId: string;
  date: string;
  payee: string;
  categoryId: string | null;
  memo: string;
  outflowCents: Cents;
  inflowCents: Cents;
  cleared: ClearedStatus;
  approved: boolean;
  flag: string | null;
  repeat: string;
} {
  return {
    accountId: t.accountId,
    date: t.date,
    payee: t.payee,
    categoryId: t.categoryId,
    memo: t.memo ?? '',
    outflowCents: t.outflow,
    inflowCents: t.inflow,
    cleared: t.cleared,
    approved: t.approved,
    flag: t.flag ?? null,
    repeat: t.repeat,
  };
}

/**
 * Register row press (web, YNAB register): plain click opens the inline
 * editor; ctrl/cmd-click toggles the row's selection; shift-click selects the
 * whole range from the last-clicked anchor. Modifier keys exist only on web
 * pointer events.
 */
export function rowPressIntent(
  web: boolean,
  mod: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
): 'open' | 'range' | 'toggle' {
  if (!web || (!mod.ctrlKey && !mod.metaKey && !mod.shiftKey)) return 'open';
  return mod.shiftKey ? 'range' : 'toggle';
}

export type SelectionShortcut =
  | { kind: 'clear'; cleared: 'cleared' | 'uncleared' }
  | { kind: 'unmatch' }
  | { kind: 'duplicate' }
  | { kind: 'match' }
  | { kind: 'delete' };

/**
 * Selection shortcuts (web, Image #2 keycaps): C marks cleared/uncleared,
 * M matches, shift+U unmatches, shift+D duplicates, delete/backspace deletes.
 * Null = the key is not ours (or its action is unavailable).
 */
export function selectionShortcut(
  ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean },
  flags: { allCleared: boolean; hasMatched: boolean; canMatch: boolean },
): SelectionShortcut | null {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return null;
  if (ev.key === 'c' || ev.key === 'C') {
    return { kind: 'clear', cleared: flags.allCleared ? 'uncleared' : 'cleared' };
  }
  if (ev.shiftKey && (ev.key === 'u' || ev.key === 'U')) return flags.hasMatched ? { kind: 'unmatch' } : null;
  if (ev.shiftKey && (ev.key === 'd' || ev.key === 'D')) return { kind: 'duplicate' };
  if (!ev.shiftKey && (ev.key === 'm' || ev.key === 'M')) return flags.canMatch ? { kind: 'match' } : null;
  if (ev.key === 'Delete' || ev.key === 'Backspace') return { kind: 'delete' };
  return null;
}
