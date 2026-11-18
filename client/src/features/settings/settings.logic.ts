/**
 * Pure view logic of the budget settings panes: which budgets the switcher
 * lists where, the copy that depends on a budget, the delete confirmation
 * rule and the format preview line.
 */
import { formatDateWith, formatMoneyWith } from '@/domain/format';
import type { FmtPrefs } from '@/domain/fmtPrefs';

interface Archivable {
  name: string;
  archived_at?: string | null;
}

/** Open Budget lists: active budgets first, archived ones in their own section; list order kept. */
export function splitBudgets<T extends Archivable>(rows: readonly T[] | undefined): { active: T[]; archived: T[] } {
  const all = rows ?? [];
  return { active: all.filter((b) => !b.archived_at), archived: all.filter((b) => b.archived_at) };
}

/**
 * Rename, archive, delete, restore and Fresh Start are the owner's (the API
 * answers 403 to anyone else), so the menu does not offer them to a member.
 * Unknown (list not loaded) counts as not the owner.
 */
export function canManageBudget(b: { is_owner: boolean } | null | undefined): boolean {
  return b?.is_owner === true;
}

/** What a member reads where the owner has the rename and archive/delete controls. */
export function ownerOnlyHint(owner: { name: string | null; email: string | null } | null | undefined): string {
  const who = owner?.name?.trim() || owner?.email || null;
  return who
    ? `Only the owner (${who}) can rename, archive or delete this budget.`
    : 'Only the owner can rename, archive or delete this budget.';
}

/** Row label of an archived budget: its name plus the archive date. */
export function archivedBudgetLabel(b: Archivable, formatDate: (iso: string) => string): string {
  return b.archived_at ? `${b.name} · ${formatDate(b.archived_at)}` : b.name;
}

/** Fresh Start explainer for the active budget (or the prompt to pick one). */
export function freshStartHint(current: { name: string } | null | undefined): string {
  return current
    ? `Archives "${current.name}" — renamed with the archive timestamp, every row kept — and starts a new "${current.name}". Kept: accounts, linked-account balances and history through today, scheduled transactions, targets, category and payee setup. Reset: budgeted amounts, month notes, category activity. Archived budgets stay in Open Budget.`
    : 'Switch to a budget first.';
}

/** Explainer above the archive/unarchive row of Plan Settings. */
export function manageBudgetHint(name: string, archived: boolean): string {
  return archived
    ? `"${name}" is archived. Unarchive to bring it back, or delete it permanently.`
    : `Archives "${name}" — every row is kept. Archived budgets stay in Open Budget.`;
}

/** Warning inside the permanent-delete modal. */
export function deleteBudgetNote(name: string): string {
  return `Deletes "${name}" and every transaction, account, category and setting in it. This cannot be undone.`;
}

/** The delete only fires once "delete" is typed (any case, surrounding spaces ignored). */
export function isDeleteArmed(confirmText: string): boolean {
  return confirmText.trim().toLowerCase() === 'delete';
}

/** Live preview under the format selects: a sample amount and a sample date. */
export function fmtPreviewText(fmt: FmtPrefs, masked: boolean): string {
  return `${formatMoneyWith(fmt, 131451, masked)} · ${formatDateWith(fmt, '2026-06-30')}`;
}
