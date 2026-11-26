/**
 * Pure rules of the Manage Payees screen: merge candidates, what a rename
 * commit actually sends, and the small view strings (the list groups and the
 * renaming rules are in renameRules.logic.ts). Wire-typed (PayeeAdminRow), so it lives beside the screen rather
 * than in domain/.
 */

import type { PayeeAdminRow } from '@/budget/data/rows';
import type { MoneyFormat } from '@/domain/format';
import { t } from './i18n';

/** Merge targets: other live, non-transfer payees in the budget. */
export function mergeCandidatesFor(all: PayeeAdminRow[], selected: PayeeAdminRow | null): PayeeAdminRow[] {
  return selected ? all.filter((p) => p.id !== selected.id && !p.deleted && p.transfer_account_id === null) : [];
}

/** The name a rename commit sends, or null when there is nothing to rename. */
export function renameToCommit(draft: string | null, currentName: string): string | null {
  if (draft == null) return null;
  const name = draft.trim();
  if (!name || name === currentName) return null;
  return name;
}

/** "3 transactions · last used 2026-01-02" / "0 transactions · never used". */
export function activityLine(
  payee: Pick<PayeeAdminRow, 'transaction_count' | 'last_used_date'>,
  /** The person's date format (`useMoneyFormat()`); without it the date is ISO. */
  fmt?: Pick<MoneyFormat, 'formatDate'>,
): string {
  const count = payee.transaction_count;
  return payee.last_used_date
    ? t('activity.lastUsed', { count, date: (fmt?.formatDate ?? ((iso: string) => iso))(payee.last_used_date.slice(0, 10)) })
    : t('activity.neverUsed', { count });
}

/** Pages of a paginated table; an empty table still has page 1. */
export function pageCount(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(total / pageSize));
}
