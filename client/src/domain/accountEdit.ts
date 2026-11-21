/**
 * Pure rules of the Edit Account form: the working-balance line (a display
 * string until commit), what Save sends, and the Close Account flow (zero
 * the balance out, then close).
 */

import type { MoneyFormat } from './format';
import type { Cents } from './types';
import { t } from './i18n';

export interface BalanceEdit {
  /** What the balance field shows: the draft, else the formatted working balance. */
  text: string;
  /** The field parsed back to cents. */
  cents: Cents;
  /** True when the field no longer says the working balance. */
  changed: boolean;
}

/** The working-balance line: untouched it mirrors the account's balance. */
export function balanceEdit(
  draft: string | null,
  working: Cents,
  fmt: Pick<MoneyFormat, 'formatMoney' | 'parseMoney'>,
): BalanceEdit {
  const text = draft ?? fmt.formatMoney(working);
  const cents = fmt.parseMoney(text);
  return { text, cents, changed: cents !== working };
}

export interface AccountForm {
  name: string;
  note: string;
  /** The picked owner; sent only when it differs from the saved one. */
  userId: string | null;
  savedUserId: string | null;
  /** Reopen (false) / close (true) riding on this save; undefined = untouched. */
  closed?: boolean;
  balance: Pick<BalanceEdit, 'cents' | 'changed'>;
}

export interface AccountSavePatch {
  name: string;
  note: string | null;
  userId?: string | null;
  closed?: boolean;
  workingBalanceCents?: Cents;
}

/**
 * What Save sends, or the validation error that blocks it. Name and note are
 * trimmed (a blank note is null); owner, closed and balance ride along only
 * when they changed.
 */
export function accountSavePatch(form: AccountForm): { error: string } | { patch: AccountSavePatch } {
  if (!form.name.trim()) return { error: t('account.nicknameRequired') };
  return {
    patch: {
      name: form.name.trim(),
      note: form.note.trim() || null,
      ...(form.userId !== form.savedUserId ? { userId: form.userId } : {}),
      ...(form.closed !== undefined ? { closed: form.closed } : {}),
      ...(form.balance.changed ? { workingBalanceCents: form.balance.cents } : {}),
    },
  };
}

/**
 * YNAB close flow: zero the balance out and flip closed in one save — the
 * workingBalanceCents: 0 edit books the adjustment transaction server-side
 * (same mechanic as reconciliation). An already-zero account just closes.
 */
export function closeAccountPatch(working: Cents): { closed: true; workingBalanceCents?: 0 } {
  return { ...(working !== 0 ? { workingBalanceCents: 0 as const } : {}), closed: true };
}

export type CloseConfirm =
  /** Zero balance: the plain "are you sure". */
  | { kind: 'plain' }
  /** An adjustment for `adjustment` (absolute) will be booked; `leavesPlan`
   * warns that on-budget money disappears from the plan. */
  | { kind: 'adjust'; adjustment: Cents; leavesPlan: boolean };

/** Which Close Account confirm to show for the balance being zeroed out. */
export function closeConfirm(amount: Cents, onBudget: boolean): CloseConfirm {
  if (amount === 0) return { kind: 'plain' };
  return { kind: 'adjust', adjustment: Math.abs(amount), leavesPlan: onBudget && amount > 0 };
}
