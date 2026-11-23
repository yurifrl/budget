/**
 * What budget needs from the connections tables (`connections`,
 * `connection_transactions`), behind one module exported from the
 * connections barrel. Budget never names these tables in its own SQL except
 * where noted in docs/decisions.md (the accounts list's display join).
 *
 * Every function takes a Queryable so it runs inside the caller's
 * transaction (account linking, card-payment pairing).
 */
import type { Queryable } from '../core/db';

/**
 * The caller's own connection (owner-scoped: another user's id is
 * indistinguishable from a bogus one). Used when a budget account is linked.
 */
export async function findUserConnection(
  db: Queryable,
  connectionId: string,
  userId: string,
): Promise<{ institution: string | null; status: string } | undefined> {
  const conn = await db.query<{ institution: string | null; status: string }>(
    'SELECT institution, status FROM connections WHERE id = $1 AND user_id = $2',
    [connectionId, userId],
  );
  return conn.rows[0];
}

/** Of `transactionIds`, the ones whose sync shadow row is `blocked`. */
export async function blockedImportShadowIds(db: Queryable, transactionIds: readonly string[]): Promise<Set<string>> {
  if (transactionIds.length === 0) return new Set();
  const r = await db.query<{ transaction_id: string }>(
    'SELECT transaction_id FROM connection_transactions WHERE transaction_id = ANY($1) AND blocked',
    [transactionIds],
  );
  return new Set(r.rows.map((row) => row.transaction_id));
}

/**
 * Freeze the sync shadow rows of `transactionIds` (later syncs leave the
 * transactions alone). Rows without a shadow are unaffected.
 */
export async function blockImportShadows(db: Queryable, transactionIds: readonly string[]): Promise<void> {
  await db.query(
    `UPDATE connection_transactions SET blocked = true, updated_at = now() WHERE transaction_id = ANY($1)`,
    [transactionIds],
  );
}

/** What the bank sent for one imported transaction (see `getImportMetadata`). */
export type ImportMetadata = {
  provider: string;
  externalTransactionId: string;
  /** The provider's transaction object as last received; null until the row's next sync. */
  raw: Record<string, unknown> | null;
  /** When `raw` was last written; null when it never was. */
  rawReceivedAt: Date | null;
  /** The engine-owned fields as last written (date, amount, memo, payee). */
  lastSyncedPayload: Record<string, unknown>;
  blocked: boolean;
  updatedAt: Date;
};

/**
 * The sync shadow of `transactionId` with the provider's raw payload, or
 * undefined for a transaction the bank sync never imported. Not scoped: the
 * caller authorises the transaction (by budget) first.
 */
export async function getImportMetadata(db: Queryable, transactionId: string): Promise<ImportMetadata | undefined> {
  const r = await db.query<{
    provider: string;
    external_transaction_id: string;
    raw_payload: Record<string, unknown> | null;
    raw_received_at: Date | null;
    last_synced_payload: Record<string, unknown>;
    blocked: boolean;
    updated_at: Date;
  }>(
    `SELECT provider, external_transaction_id, raw_payload, raw_received_at,
            last_synced_payload, blocked, updated_at
     FROM connection_transactions WHERE transaction_id = $1`,
    [transactionId],
  );
  const row = r.rows[0];
  if (!row) return undefined;
  return {
    provider: row.provider,
    externalTransactionId: row.external_transaction_id,
    raw: row.raw_payload,
    rawReceivedAt: row.raw_received_at,
    lastSyncedPayload: row.last_synced_payload,
    blocked: row.blocked,
    updatedAt: row.updated_at,
  };
}
