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
import { TRANSFER_PAYEE_RE, transferPayeeName } from '@shared/domain/transfers';
import { HttpError } from '../../core/validate';
import { deriveDeltas, type BalanceDelta } from './transactions';

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

/** The per-account "Transfer : <name>" payee, created (and linked) when missing. */
export async function ensureTransferPayee(
  client: PoolClient,
  budgetId: string,
  accountId: string,
  accountName: string,
): Promise<string> {
  const existing = await client.query<{ transfer_payee_id: string | null }>(
    'SELECT transfer_payee_id FROM accounts WHERE id = $1',
    [accountId],
  );
  const linked = existing.rows[0]?.transfer_payee_id;
  if (linked) return linked;
  const payee = await client.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name, transfer_account_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (budget_id, name) DO UPDATE
       SET transfer_account_id = EXCLUDED.transfer_account_id, deleted = false
     RETURNING id`,
    [budgetId, transferPayeeName(accountName), accountId],
  );
  await client.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [payee.rows[0].id, accountId]);
  return payee.rows[0].id;
}

/**
 * The peer account a payee transfers to, or null for an ordinary payee.
 * A payee named "Transfer : <account>" that was never linked (accounts created
 * before transfer payees existed) is linked on first use.
 */
export async function resolveTransferPeer(
  client: PoolClient,
  budgetId: string,
  payeeId: string | null,
  ownAccountId: string,
): Promise<TransferPeer | null> {
  if (!payeeId) return null;
  const payee = await client.query<{
    name: string;
    transfer_account_id: string | null;
  }>('SELECT name, transfer_account_id FROM payees WHERE id = $1 AND budget_id = $2', [payeeId, budgetId]);
  const row = payee.rows[0];
  if (!row) return null;
  let peerId = row.transfer_account_id;
  if (!peerId) {
    const peerName = TRANSFER_PAYEE_RE.exec(row.name)?.[1];
    if (!peerName) return null;
    const byName = await client.query<{ id: string }>(
      'SELECT id FROM accounts WHERE budget_id = $1 AND name = $2 AND deleted = false',
      [budgetId, peerName.trim()],
    );
    if (byName.rowCount !== 1) return null;
    peerId = byName.rows[0].id;
    await client.query('UPDATE payees SET transfer_account_id = $1 WHERE id = $2', [peerId, payeeId]);
    await client.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2 AND transfer_payee_id IS NULL', [
      payeeId,
      peerId,
    ]);
  }
  if (peerId === ownAccountId) throw new HttpError(400, 'cannot transfer to the same account');
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
  if (!peer || !own) throw new HttpError(400, 'transfer account not found in budget');
  if (peer.closed) throw new HttpError(409, 'account is closed');
  return {
    accountId: peerId,
    onBudget: peer.on_budget,
    internal: peer.on_budget && own.on_budget,
  };
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
  client: PoolClient,
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
export async function deleteMirror(client: PoolClient, budgetId: string, mirrorId: string): Promise<BalanceDelta[]> {
  const res = await client.query<TransferLeg>(
    `UPDATE transactions SET deleted = true, transfer_transaction_id = NULL
     WHERE id = $1 AND budget_id = $2 AND deleted = false
     RETURNING id, account_id, date::text AS date, memo, amount, cleared, approved`,
    [mirrorId, budgetId],
  );
  return res.rows[0] ? deriveDeltas(ledger(res.rows[0]), null) : [];
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
  if (peerAccountId === row.account_id) throw new HttpError(400, 'cannot transfer to the same account');
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
  if (mirror) deltas.push(...(await deleteMirror(client, budgetId, mirror.id)));
  if (peerAccountId) {
    deltas.push(...(await insertMirror(client, budgetId, row, peerAccountId)).deltas);
  } else {
    await client.query(
      'UPDATE transactions SET transfer_account_id = NULL, transfer_transaction_id = NULL WHERE id = $1',
      [txnId],
    );
  }
  return deltas;
}
