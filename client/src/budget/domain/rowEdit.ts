/**
 * Pure dirty-checks for the register's inline add/edit row. The row
 * auto-commits when the pointer goes down outside it (YNAB behavior): these
 * helpers decide whether closing means "save" or "discard" — any difference
 * between the draft state and the stored transaction is dirty.
 */

import type { Cents, Transaction, TransactionSplit } from './types';

/** Parent-level fields the inline row edits (split legs ride along separately). */
export interface RowDraft {
  accountId: string;
  /** Resolved ISO date — parseDateInput(dateText) ?? today. */
  date: string;
  payee: string;
  categoryId: string | null;
  memo: string;
  outflowCents: Cents;
  inflowCents: Cents;
}

const trimmed = (s: string): string => s.trim();

/**
 * A NEW-row draft is dirty when anything beyond the row's defaults was typed.
 * Defaults: the row's base account, today's date, empty payee/category/memo,
 * zero amount.
 */
export function newDraftDirty(d: RowDraft, baseAccountId: string, today: string): boolean {
  if (d.accountId !== baseAccountId) return true;
  if (d.date !== today) return true;
  if (trimmed(d.payee) !== '') return true;
  if (d.categoryId !== null) return true;
  if (trimmed(d.memo) !== '') return true;
  if (d.outflowCents !== 0 || d.inflowCents !== 0) return true;
  return false;
}

const legKey = (s: TransactionSplit): string =>
  `${s.categoryId ?? ''}\u0000${s.memo.trim()}\u0000${s.outflow}\u0000${s.inflow}`;

const sameSplits = (a: TransactionSplit[], b: TransactionSplit[]): boolean =>
  a.length === b.length && a.every((s, i) => legKey(s) === legKey(b[i]!));

/**
 * An EDIT-row draft is dirty when any stored field the row edits changed, or —
 * with the split panel open — any leg changed. A closed panel is an explicit
 * un-split gesture, so panel state is ignored there and the parent fields
 * alone decide.
 */
export function editDirty(t: Transaction, d: RowDraft, draftSplits?: TransactionSplit[]): boolean {
  if (d.accountId !== t.accountId) return true;
  if (d.date !== t.date) return true;
  if (trimmed(d.payee) !== t.payee) return true;
  if (d.categoryId !== t.categoryId) return true;
  if (trimmed(d.memo) !== t.memo) return true;
  if (d.outflowCents !== t.outflow || d.inflowCents !== t.inflow) return true;
  if (draftSplits && !sameSplits(draftSplits, t.splits ?? [])) return true;
  return false;
}
