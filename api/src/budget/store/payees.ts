/**
 * Budget store: payees. SQL only; every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';

/**
 * Find-or-create a payee by exact name (no trimming, no rename rules): the
 * system payees ("Starting Balance", "Reconciliation Adjustment", a deleted
 * account's plain payee).
 */
export async function findOrCreatePayeeByName(db: Queryable, budgetId: string, name: string): Promise<string> {
  const payeeResult = await db.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name)
         VALUES ($1, $2)
         ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
         RETURNING id`,
    [budgetId, name],
  );
  return payeeResult.rows[0]!.id;
}

/** Re-point live transactions from one payee to another. */
export async function repointLiveTransactionsPayee(db: Queryable, fromPayeeId: string | null, toPayeeId: string): Promise<void> {
  await db.query('UPDATE transactions SET payee_id = $2 WHERE payee_id = $1 AND deleted = false', [fromPayeeId, toPayeeId]);
}

/** Retire a transfer payee (drop its account link, soft-delete). */
export async function retireTransferPayee(db: Queryable, payeeId: string | null): Promise<void> {
  await db.query('UPDATE payees SET transfer_account_id = NULL, deleted = true WHERE id = $1 AND deleted = false', [payeeId]);
}
