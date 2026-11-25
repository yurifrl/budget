/**
 * The payee of a transaction as the register sends it: an id (new clients) or
 * TEXT (every released client sends the payee text on every edit, duplicate and
 * make-repeat, and that text can be stale: another device renamed the account,
 * or the row predates per-account transfer payees).
 *
 * Rules (edit):
 *  1. `payee_id` present: it wins over the text (null = no payee).
 *  2. The text equals the name of the row's current payee (a "Transfer : ..."
 *     payee or an ordinary one): unchanged, whatever resolution would say now
 *     (a legacy name-only payee, the payee of a renamed account, a numbered
 *     name, a payee a renaming rule would now replace).
 *  3. The row is already a transfer and the text equals a FORMER name of its
 *     current transfer payee (the account was renamed on another device; a new
 *     account may even hold that name now): unchanged.
 *  4. The row is already a transfer and the text reads "Transfer : ..." but names
 *     no account, or names the row's current peer: unchanged. Only a text that
 *     names a DIFFERENT live account (or an ordinary payee) changes it. A text
 *     a renaming rule turns into the name of an ORDINARY payee (one nobody
 *     links, even one called "Transfer : X") is that ordinary payee: the row
 *     stops being a transfer.
 *  5. Anything else resolves as on create (`resolvePayeeId`): a renaming rule
 *     that matches the text assigns its payee.
 * CREATE (register, duplicate, make-repeat, repeat rules) resends the text too, but it
 * makes a NEW row: main applied the rules to the typed text there, and the rules still
 * apply (now by assignment: "Taxi 9" typed or duplicated becomes the payee "Taxi").
 * Unchanged means the row keeps its payee id and its mirror is neither created,
 * moved nor deleted.
 */
import type { Queryable } from '../../core/db';
import { HttpError } from '../../core/validate';
import { TRANSFER_PAYEE_RE } from '@shared/domain/transfers';
import * as store from '../store/transfer-payees';
import { loadRenameRules, matchingRule, resolvePayeeId } from './transactions';
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
  // The text the released clients resend on every edit is the payee the row ALREADY has: unchanged, before any renaming rule runs
  // (a rule must not re-point "Taxi 9", stored by an earlier import, to "Taxi" because someone changed its memo). This holds for
  // ordinary payees as it always did for transfer payees.
  if (current && text.trim() !== '' && text.trim().toLowerCase() === current.name.trim().toLowerCase()) return { unchanged: true };

  const isTransferRow = row.transfer_transaction_id !== null || row.transfer_account_id !== null;
  if (isTransferRow && row.payee_id && (await store.isFormerName(client, budgetId, row.payee_id, text.trim()))) return { unchanged: true };
  if (isTransferRow) {
    // A renaming rule that matches ASSIGNS its payee. The transfer payee of the row's own peer
    // changes nothing; another account's moves the leg; an ORDINARY payee (even one called
    // "Transfer : X" that nobody links) is that ordinary payee: the row stops being a transfer.
    const hit = matchingRule(await loadRenameRules(client, budgetId), text);
    const peer = row.transfer_account_id ?? current?.transfer_account_id ?? null;
    if (hit) {
      if (!hit.transfer_account_id) return { unchanged: false, payeeId: hit.payee_id };
      if (hit.transfer_account_id === peer) return { unchanged: true };
      return { unchanged: false, payeeId: await ensureTransferPayee(client, budgetId, hit.transfer_account_id) };
    }
    const effective = text.trim();
    if (TRANSFER_PAYEE_RE.test(effective)) {
      const accountId = await resolveTransferAccountFromText(client, budgetId, effective);
      if (accountId === null || accountId === peer) return { unchanged: true };
      return { unchanged: false, payeeId: await ensureTransferPayee(client, budgetId, accountId) };
    }
  }
  return { unchanged: false, payeeId: await resolvePayeeId(client, budgetId, text) };
}
