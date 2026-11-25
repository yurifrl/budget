/**
 * Account-to-account transfers (server side).
 *
 * A transfer is a PAIR of mirrored transactions: the row the user saved (its
 * payee is the peer account's "Transfer : <name>" payee) and a counterpart in
 * the peer account with the opposite signed amount. The rows reference each
 * other through `transfer_transaction_id` and carry the peer's
 * `transfer_account_id`. The server owns the pairing so every write path
 * (inline add, edit, delete) stays atomic; the client only sends the saved
 * row and the balance deltas of ITS account — the mirror's balances are moved
 * here.
 */
import type { PoolClient } from 'pg';
import type { Queryable } from '../../core/db';
import { blockImportShadows, listImportHints, setImportShadowsBlocked } from '../../connections';
import { HttpError } from '../../core/validate';
import * as payeeStore from '../store/transfer-payees';
import * as store from '../store/transfers';
import { deriveDeltas, upsertPayee, type BalanceDelta } from './transactions';
import { ensureTransferPayee } from './transfer-payees';


/** The row facts a mirror is derived from (amount in milliunits). */
export interface TransferLeg {
  id: string;
  account_id: string;
  date: string;
  memo: string | null;
  amount: string | number;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
}

/** Both legs of an on-budget <-> on-budget transfer stay inside the budget: no category. */
export interface TransferPeer {
  accountId: string;
  onBudget: boolean;
  /** True when both accounts are on budget (no category on either leg). */
  internal: boolean;
}

export { ensureTransferPayee } from './transfer-payees';

/**
 * The peer account a payee transfers to, or null for an ordinary payee. The
 * identity is the payee's `transfer_account_id` (set when the account's
 * transfer payee is created); payee TEXT is resolved to that payee before it
 * gets here (`resolveTransferPayeeText`), so no name is parsed in this check.
 */
export async function resolveTransferPeer(
  client: PoolClient,
  budgetId: string,
  payeeId: string | null,
  ownAccountId: string,
): Promise<TransferPeer | null> {
  if (!payeeId) return null;
  const payee = await client.query<{ transfer_account_id: string | null }>(
    'SELECT transfer_account_id FROM payees WHERE id = $1 AND budget_id = $2',
    [payeeId, budgetId],
  );
  const peerId = payee.rows[0]?.transfer_account_id;
  if (!peerId) return null;
  if (peerId === ownAccountId) throw new HttpError(400, 'cannot transfer to the same account', 'cannot_transfer_to_same_account');
  const accounts = await client.query<{
    id: string;
    on_budget: boolean;
    closed: boolean;
  }>('SELECT id, on_budget, closed FROM accounts WHERE id = ANY($1) AND budget_id = $2 AND deleted = false', [
    [peerId, ownAccountId],
    budgetId,
  ]);
  const peer = accounts.rows.find((a) => a.id === peerId);
  const own = accounts.rows.find((a) => a.id === ownAccountId);
  if (!peer || !own) throw new HttpError(400, 'transfer account not found in budget', 'transfer_account_not_in_budget');
  if (peer.closed) throw new HttpError(409, 'account is closed', 'account_closed');
  return {
    accountId: peerId,
    onBudget: peer.on_budget,
    internal: peer.on_budget && own.on_budget,
  };
}

/**
 * The peer a transfer payee leads to for a row that is not being written by a
 * person (repeat-rule generation): null for an ordinary payee AND for a transfer
 * payee whose account cannot receive a transfer now (the row's own account, a
 * deleted or closed account), where the caller skips the row.
 */
export async function findTransferPeer(
  client: PoolClient,
  budgetId: string,
  payeeId: string | null,
  ownAccountId: string,
): Promise<{ kind: 'none' } | { kind: 'invalid' } | { kind: 'peer'; peer: TransferPeer }> {
  if (!payeeId) return { kind: 'none' };
  const payee = await client.query<{ transfer_account_id: string | null }>(
    'SELECT transfer_account_id FROM payees WHERE id = $1 AND budget_id = $2',
    [payeeId, budgetId],
  );
  const peerId = payee.rows[0]?.transfer_account_id;
  if (!peerId) return { kind: 'none' };
  if (peerId === ownAccountId) return { kind: 'invalid' };
  const accounts = await client.query<{ id: string; on_budget: boolean; closed: boolean }>(
    'SELECT id, on_budget, closed FROM accounts WHERE id = ANY($1) AND budget_id = $2 AND deleted = false',
    [[peerId, ownAccountId], budgetId],
  );
  const peer = accounts.rows.find((a) => a.id === peerId);
  const own = accounts.rows.find((a) => a.id === ownAccountId);
  if (!peer || !own || peer.closed) return { kind: 'invalid' };
  return { kind: 'peer', peer: { accountId: peerId, onBudget: peer.on_budget, internal: peer.on_budget && own.on_budget } };
}

/** The ledger state `deriveDeltas` needs, from a leg. */
const ledger = (leg: Pick<TransferLeg, 'account_id' | 'amount' | 'cleared'>) => ({
  account_id: leg.account_id,
  amount: leg.amount,
  cleared: leg.cleared,
});

/**
 * Insert the peer-account counterpart of `leg` and link both rows. Returns the
 * mirror's balance deltas (to be applied by the caller, with the leg's own).
 */
export async function insertMirror(
  client: Queryable,
  budgetId: string,
  leg: TransferLeg,
  peerAccountId: string,
): Promise<{ mirrorId: string; deltas: BalanceDelta[] }> {
  const own = await client.query<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [leg.account_id]);
  const payeeId = await ensureTransferPayee(client, budgetId, leg.account_id, own.rows[0].name);
  const mirrorAmount = -Number(leg.amount);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO transactions
      (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, repeat, deleted,
       transfer_account_id, transfer_transaction_id)
     VALUES ($1, $2, $3, $4, $5, NULL, $6, $7, $8, 'never', false, $9, $10)
     RETURNING id`,
    [
      budgetId,
      peerAccountId,
      leg.date,
      mirrorAmount,
      payeeId,
      leg.memo,
      leg.cleared,
      leg.approved,
      leg.account_id,
      leg.id,
    ],
  );
  const mirrorId = inserted.rows[0].id;
  await client.query('UPDATE transactions SET transfer_account_id = $1, transfer_transaction_id = $2 WHERE id = $3', [
    peerAccountId,
    mirrorId,
    leg.id,
  ]);
  return {
    mirrorId,
    deltas: deriveDeltas(
      null,
      ledger({
        account_id: peerAccountId,
        amount: mirrorAmount,
        cleared: leg.cleared,
      }),
    ),
  };
}

/** Soft-delete a mirror row; returns the deltas that take its amount back out of its account. */
export async function deleteMirror(client: Queryable, budgetId: string, mirrorId: string): Promise<BalanceDelta[]> {
  const res = await client.query<TransferLeg>(
    `UPDATE transactions SET deleted = true, transfer_transaction_id = NULL
     WHERE id = $1 AND budget_id = $2 AND deleted = false
     RETURNING id, account_id, date::text AS date, memo, amount, cleared, approved`,
    [mirrorId, budgetId],
  );
  return res.rows[0] ? deriveDeltas(ledger(res.rows[0]), null) : [];
}

/**
 * A transfer leg stops being a transfer (its payee was edited to an ordinary
 * one, it moved to another peer, or it was deleted): take its mirror out of
 * the pair. Returns the balance deltas of the mirror's removal.
 *
 *  - a mirror THE SYSTEM OR A PERSON LINKED from a bank row (a `transfer_links`
 *    record with `created_mirror = false`) is NEVER deleted: it is restored to
 *    what it was before the link, exactly as POST /transfers/unlink does (its
 *    previous payee and category, the sync shadow unblocked when it was not
 *    blocked before, marked "manual" so it is suggested but not re-linked on
 *    its own). Its bank id stays live, so a later sync neither skips nor
 *    duplicates it, and no balance moves;
 *  - any other row that came from an import (`import_id` set, no usable
 *    record: restored data, rows linked before records existed) gets the same
 *    treatment with the payee its import name stands for;
 *  - a hand-made mirror (register / "Other account..." link / a user's own row
 *    that was linked: no import id) is soft-deleted and its balance reversed.
 * The link records of both legs are dropped (the pair no longer exists).
 */
export async function removeMirror(client: Queryable, budgetId: string, legId: string, mirrorId: string): Promise<BalanceDelta[]> {
  const mirror = await store.getMirrorFacts(client, budgetId, mirrorId);
  if (!mirror) {
    await store.deleteTransferLinks(client, budgetId, [legId, mirrorId]);
    return [];
  }
  const record = await store.getTransferLink(client, budgetId, mirrorId);
  const own = record && record.peer_transaction_id === legId ? record : undefined;
  let deltas: BalanceDelta[] = [];
  if (own && !own.created_mirror && mirror.import_id !== null) {
    await store.restoreUnlinkedLeg(client, mirrorId, {
      payeeId: await usablePayee(client, budgetId, own.prev_payee_id),
      categoryId: own.prev_category_id,
    });
    if (own.prev_blocked === false) await setImportShadowsBlocked(client, [mirrorId], false);
    await markReleasedRow(client, budgetId, mirrorId, legId);
  } else if (!own && mirror.import_id !== null) {
    await store.restoreUnlinkedLeg(client, mirrorId, { payeeId: await ordinaryPayeeOfImport(client, budgetId, mirror.import_payee_name), categoryId: null });
    await markReleasedRow(client, budgetId, mirrorId, legId);
  } else {
    deltas = await deleteMirror(client, budgetId, mirrorId);
  }
  await store.deleteTransferLinks(client, budgetId, [legId, mirrorId]);
  await store.clearTransferHints(client, budgetId, [mirrorId]);
  return deltas;
}

/** Mark a restored bank row 'manual' and remember that THIS leg released it (see `store.markReleased`). */
async function markReleasedRow(client: Queryable, budgetId: string, rowId: string, legId: string): Promise<void> {
  const row = await store.getRowFields(client, budgetId, rowId);
  if (row) await store.markReleased(client, budgetId, row, legId);
}

/** A recorded previous payee, when it still exists as an ordinary live payee of the budget. */
async function usablePayee(client: Queryable, budgetId: string, payeeId: string | null): Promise<string | null> {
  if (!payeeId) return null;
  const row = await payeeStore.getPayeeRow(client, budgetId, payeeId);
  return row && !row.deleted && !row.transfer_account_id ? row.id : null;
}

/** The ordinary payee an import's payee text names (created when new); null when blank or when the name belongs to a transfer payee. */
async function ordinaryPayeeOfImport(client: Queryable, budgetId: string, importName: string | null): Promise<string | null> {
  const name = importName?.trim();
  if (!name) return null;
  const holder = await payeeStore.findPayeeRowByName(client, budgetId, name);
  if (!holder) return upsertPayee(client, budgetId, name);
  return !holder.deleted && !holder.transfer_account_id ? holder.id : null;
}

/**
 * Link a leg that becomes a transfer to the bank row IT released earlier, when
 * that row is still exactly as the release left it (see `store.findReleasedBankRow`).
 * Any other row is none of its business: a mirror is created as on main.
 * No row is created and no balance moves. Both legs get a link record, so
 * POST /transfers/unlink works on the pair.
 */
async function relinkReleasedBankRow(client: Queryable, budgetId: string, row: TransferLeg, peerAccountId: string): Promise<boolean> {
  const foundId = await store.findReleasedBankRow(client, budgetId, row.id, peerAccountId, -Number(row.amount));
  if (!foundId) return false;
  const found = await store.getRowFields(client, budgetId, foundId);
  if (!found) return false;
  const ownPayee = await ensureTransferPayee(client, budgetId, row.account_id);
  const peerPayee = await ensureTransferPayee(client, budgetId, peerAccountId);
  await store.writeTransferLeg(client, found.id, row.account_id, row.id, ownPayee);
  await client.query('UPDATE transactions SET transfer_account_id = $2, transfer_transaction_id = $3, payee_id = $4 WHERE id = $1', [
    row.id,
    peerAccountId,
    found.id,
    peerPayee,
  ]);
  const blocked = (await listImportHints(client, [found.id])).get(found.id)?.blocked ?? null;
  await store.insertTransferLink(client, budgetId, {
    transaction_id: found.id,
    peer_transaction_id: row.id,
    method: 'user',
    prev_payee_id: found.payee_id,
    prev_category_id: found.category_id,
    prev_blocked: blocked,
    created_mirror: false,
  });
  await store.insertTransferLink(client, budgetId, {
    transaction_id: row.id,
    peer_transaction_id: found.id,
    method: 'user',
    prev_payee_id: null,
    prev_category_id: null,
    prev_blocked: null,
    created_mirror: false,
  });
  await blockImportShadows(client, [found.id]);
  await store.setTransferMarks(client, budgetId, [found.id], null);
  await store.clearTransferHints(client, budgetId, [found.id]);
  return true;
}

/**
 * Bring a row's mirror in line with the row after an edit; returns the
 * MIRROR-side balance deltas only. `requestedPeerId` is the transfer's peer
 * after the edit (null = no longer a transfer; undefined = unchanged, keep
 * whatever mirror exists).
 */
export async function syncMirror(
  client: PoolClient,
  budgetId: string,
  txnId: string,
  requestedPeerId: string | null | undefined,
): Promise<BalanceDelta[]> {
  const rowRes = await client.query<TransferLeg & { transfer_transaction_id: string | null }>(
    `SELECT id, account_id, date::text AS date, memo, amount, cleared, approved, transfer_transaction_id
     FROM transactions WHERE id = $1 AND budget_id = $2`,
    [txnId, budgetId],
  );
  const row = rowRes.rows[0];
  if (!row) return [];
  const mirrorId = row.transfer_transaction_id;
  const mirrorRes = mirrorId
    ? await client.query<TransferLeg>(
        `SELECT id, account_id, date::text AS date, memo, amount, cleared, approved
         FROM transactions WHERE id = $1 AND budget_id = $2 AND deleted = false`,
        [mirrorId, budgetId],
      )
    : null;
  const mirror = mirrorRes?.rows[0] ?? null;
  const peerAccountId = requestedPeerId === undefined ? (mirror?.account_id ?? null) : requestedPeerId;
  if (peerAccountId === row.account_id) throw new HttpError(400, 'cannot transfer to the same account', 'cannot_transfer_to_same_account');
  if (peerAccountId) {
    // On-budget <-> on-budget transfers carry no category, whatever the edit sent.
    await client.query(
      `UPDATE transactions SET category_id = NULL
       WHERE id = ANY($1) AND category_id IS NOT NULL
         AND (SELECT count(*) FROM accounts WHERE id = ANY($2) AND on_budget) = 2`,
      [[row.id, ...(mirror ? [mirror.id] : [])], [row.account_id, peerAccountId]],
    );
  }

  if (mirror && peerAccountId && mirror.account_id === peerAccountId) {
    // Same peer: update the mirror in place. Cleared status stays per side
    // (each bank clears on its own). The row may have MOVED account, so the
    // mirror's payee/back-reference follow it.
    const own = await client.query<{ name: string }>('SELECT name FROM accounts WHERE id = $1', [row.account_id]);
    const payeeId = await ensureTransferPayee(client, budgetId, row.account_id, own.rows[0].name);
    const next = { ...mirror, amount: -Number(row.amount) };
    await client.query(
      'UPDATE transactions SET date = $1, memo = $2, amount = $3, payee_id = $4, transfer_account_id = $5 WHERE id = $6',
      [row.date, row.memo, next.amount, payeeId, row.account_id, mirror.id],
    );
    await client.query('UPDATE transactions SET transfer_account_id = $1 WHERE id = $2', [peerAccountId, row.id]);
    return deriveDeltas(ledger(mirror), ledger(next));
  }
  const deltas: BalanceDelta[] = [];
  if (mirror) deltas.push(...(await removeMirror(client, budgetId, row.id, mirror.id)));
  if (peerAccountId) {
    // The bank row this very leg released is the other side again: link it instead
    // of adding a mirror next to it (that counted the money twice until the next sync).
    const released = await relinkReleasedBankRow(client, budgetId, row, peerAccountId);
    if (!released) deltas.push(...(await insertMirror(client, budgetId, row, peerAccountId)).deltas);
  } else {
    await client.query(
      'UPDATE transactions SET transfer_account_id = NULL, transfer_transaction_id = NULL WHERE id = $1',
      [txnId],
    );
  }
  return deltas;
}
