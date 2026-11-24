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

/** Set the sync shadow `blocked` flag of `transactionIds` (rows without a shadow are unaffected). */
export async function setImportShadowsBlocked(db: Queryable, transactionIds: readonly string[], blocked: boolean): Promise<void> {
  if (transactionIds.length === 0) return;
  await db.query(
    `UPDATE connection_transactions SET blocked = $2, updated_at = now() WHERE transaction_id = ANY($1) AND blocked <> $2`,
    [transactionIds, blocked],
  );
}

/** The provider's transfer hints for one imported row (see `listImportHints`). */
export type ImportHint = {
  /** Pluggy `category` (e.g. "Same person transfer", "Transfer - PIX"); null when absent. */
  category: string | null;
  /** Pluggy `operationType` (PIX, TED, PAGAMENTO_FATURA, ...); null when absent. */
  operationType: string | null;
  /** The bank's own timestamp for the row (raw `date`); null when absent. */
  bankTime: string | null;
  /** The sync shadow is frozen (a person edited the row). */
  blocked: boolean;
};

/**
 * The bank's transfer hints of `transactionIds` that have a sync shadow, by
 * transaction id. Input of the transfer matcher (budget-mit6); read from the
 * stored raw payload, so rows imported before it was recorded have no hints.
 */
export async function listImportHints(db: Queryable, transactionIds: readonly string[]): Promise<Map<string, ImportHint>> {
  if (transactionIds.length === 0) return new Map();
  const r = await db.query<{
    transaction_id: string;
    category: string | null;
    operation_type: string | null;
    bank_time: string | null;
    blocked: boolean;
  }>(
    `SELECT transaction_id, blocked,
            raw_payload->>'category' AS category,
            raw_payload->>'operationType' AS operation_type,
            raw_payload->>'date' AS bank_time
     FROM connection_transactions WHERE transaction_id = ANY($1)`,
    [transactionIds],
  );
  return new Map(
    r.rows.map((row) => [
      row.transaction_id,
      { category: row.category, operationType: row.operation_type, bankTime: row.bank_time, blocked: row.blocked },
    ]),
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

/** One imported card row carrying installment metadata (see `listInstallmentSources`). */
export type InstallmentSourceRow = {
  id: string;
  account_id: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** Signed milliunits (bigint arrives as a string). */
  amount: string | number;
  category_id: string | null;
  deleted: boolean;
  /** The bank's description as last received (falls back to the import payee name). */
  description: string | null;
  raw_payload: Record<string, unknown>;
};

/**
 * Every bank-imported row of the budget's open accounts whose raw payload
 * says it is a card installment (`creditCardMetadata.totalInstallments`,
 * either spelling; only card rows carry it, whatever type the budget account
 * was given), deleted rows
 * included (they still prove that installment was billed). Input of the
 * register's derived upcoming installments.
 */
export async function listInstallmentSources(db: Queryable, budgetId: string): Promise<InstallmentSourceRow[]> {
  const r = await db.query<InstallmentSourceRow>(
    `SELECT t.id, t.account_id, t.date::text AS date, t.amount, t.category_id, t.deleted,
            COALESCE(s.raw_payload->>'description', t.import_payee_name) AS description,
            s.raw_payload
     FROM connection_transactions s
     JOIN transactions t ON t.id = s.transaction_id
     JOIN accounts ac ON ac.id = t.account_id
     WHERE s.budget_id = $1 AND t.budget_id = $1
       AND NOT ac.deleted AND NOT ac.closed
       AND COALESCE(s.raw_payload->'creditCardMetadata'->>'totalInstallments',
                    s.raw_payload->'creditCardMetadata'->>'totalInstalments') IS NOT NULL`,
    [budgetId],
  );
  return r.rows;
}

/**
 * Descriptions of the POSTED (billed) live rows of `accountId` that are
 * installment `number` of `total` of a purchase made on `purchaseDate`. The
 * sync compares their stems to skip a PENDING copy of an installment that was
 * already paid (Itaú keeps listing it after an early payment).
 */
export async function postedInstallmentDescriptions(
  db: Queryable,
  accountId: string,
  installment: { number: number; total: number; purchaseDate: string | null },
): Promise<string[]> {
  const r = await db.query<{ description: string | null }>(
    `SELECT COALESCE(s.raw_payload->>'description', t.import_payee_name) AS description
     FROM connection_transactions s
     JOIN transactions t ON t.id = s.transaction_id
     WHERE t.account_id = $1 AND NOT t.deleted
       AND upper(s.raw_payload->>'status') = 'POSTED'
       AND COALESCE(s.raw_payload->'creditCardMetadata'->>'installmentNumber',
                    s.raw_payload->'creditCardMetadata'->>'instalmentNumber') = $2
       AND COALESCE(s.raw_payload->'creditCardMetadata'->>'totalInstallments',
                    s.raw_payload->'creditCardMetadata'->>'totalInstalments') = $3
       AND left(COALESCE(s.raw_payload->'creditCardMetadata'->>'purchaseDate', ''), 10) = $4`,
    [accountId, String(installment.number), String(installment.total), installment.purchaseDate ?? ''],
  );
  return r.rows.map((row) => row.description ?? '');
}
