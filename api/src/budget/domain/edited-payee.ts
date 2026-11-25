/**
 * The payee of a transaction as the register sends it: an id (new clients) or
 * TEXT (every released client sends the payee text on every edit, duplicate and
 * make-repeat, and that text can be stale: another device renamed the account,
 * or the row predates per-account transfer payees).
 *
 * Rules (edit):
 *  1. `payee_id` present: it wins over the text (null = no payee).
 *  2. The text equals the name of the row's current "Transfer : ..." payee:
 *     unchanged, whatever resolution would say now (a legacy name-only payee,
 *     the payee of a renamed account, a numbered name).
 *  3. The row is already a transfer and the text equals a FORMER name of its
 *     current transfer payee (the account was renamed on another device; a new
 *     account may even hold that name now): unchanged.
 *  4. The row is already a transfer and the text reads "Transfer : ..." but names
 *     no account, or names the row's current peer: unchanged. Only a text that
 *     names a DIFFERENT live account (or an ordinary payee) changes it. A text
 *     a renaming rule turns into the name of an ORDINARY payee (one nobody
 *     links, even one called "Transfer : X") is that ordinary payee: the row
 *     stops being a transfer.
 *  5. Anything else resolves as on create (`resolvePayeeId`).
 * Unchanged means the row keeps its payee id and its mirror is neither created,
 * moved nor deleted.
 */
import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { applyRules } from '@shared/domain/payees';
import { TRANSFER_PAYEE_RE } from '@shared/domain/transfers';
import * as store from '../store/transfer-payees';
import { loadRenameRules, resolvePayeeId } from './transactions';
import { ensureTransferPayee, resolveTransferAccountFromText } from './transfer-payees';
import type { PoolClient } from 'pg';

/** A payee id from a request: live in this budget, or a 400. null stays null. */
export async function payeeIdFromRequest(db: Queryable, budgetId: string, payeeId: string | null): Promise<string | null> {
  if (payeeId === null) return null;
  const row = await store.getPayeeRow(db, budgetId, payeeId);
  if (!row || row.deleted) throw new HttpError(400, 'payee not found in budget', 'payee_not_in_budget');
  return payeeId;
}

export interface EditedRow {
  payee_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
}

export type EditedPayee = { unchanged: true } | { unchanged: false; payeeId: string | null };

export async function resolveEditedPayee(
  client: PoolClient,
  budgetId: string,
  row: EditedRow,
  input: { payeeId?: string | null; text?: string },
): Promise<EditedPayee> {
  if (input.payeeId !== undefined) return { unchanged: false, payeeId: await payeeIdFromRequest(client, budgetId, input.payeeId) };
  const text = input.text ?? '';
  const current = row.payee_id ? await store.getPayeeRow(client, budgetId, row.payee_id) : undefined;
  if (current && TRANSFER_PAYEE_RE.test(current.name) && text.trim() === current.name.trim()) return { unchanged: true };

  const isTransferRow = row.transfer_transaction_id !== null || row.transfer_account_id !== null;
  if (isTransferRow && row.payee_id && (await store.isFormerName(client, budgetId, row.payee_id, text.trim()))) return { unchanged: true };
  if (isTransferRow) {
    const rules = await loadRenameRules(client, budgetId);
    const effective = applyRules(rules.rows, text).trim();
    if (TRANSFER_PAYEE_RE.test(effective)) {
      const fromRule = effective !== text.trim();
      // A renaming rule that produces the name of an ORDINARY payee ("Transfer : X"
      // held by a payee nobody links) means that payee: the row stops being a transfer.
      if (fromRule) {
        const holder = await store.findPayeeRowByName(client, budgetId, effective);
        if (holder && !holder.deleted && holder.transfer_account_id === null) return { unchanged: false, payeeId: holder.id };
      }
      const accountId = await resolveTransferAccountFromText(client, budgetId, effective, { fromRule });
      const peer = row.transfer_account_id ?? current?.transfer_account_id ?? null;
      if (accountId === null || accountId === peer) return { unchanged: true };
      return { unchanged: false, payeeId: await ensureTransferPayee(client, budgetId, accountId) };
    }
  }
  return { unchanged: false, payeeId: await resolvePayeeId(client, budgetId, text) };
}
