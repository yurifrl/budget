/**
 * Budget store: transactions and split legs. SQL only (moved verbatim from
 * routes/transactions.ts); every function takes a Queryable.
 */
import type { Queryable } from '../../core/db';
import type { LedgerRow } from '../domain/transactions';

/** Live register rows of a budget, newest first, with the payee name. */
export async function listLiveTransactions(db: Queryable, budgetId: string) {
  const result = await db.query(
    // payee_name rides along because GET /payees deliberately omits transfer
    // payees ("Transfer : <account>"), so the client cannot resolve payee_id
    // for transfer legs from that list (backup export lost them).
    `SELECT t.*, p.name AS payee_name
     FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.budget_id = $1 AND t.deleted = false
     ORDER BY t.date DESC, t.created_at DESC, t.id`,
    [budgetId],
  );
  return result.rows;
}

/** Live split legs of a budget (grouped by transaction_id by the caller). */
export async function listLiveSubtransactions(db: Queryable, budgetId: string) {
  const subs = await db.query(
    `SELECT id, transaction_id, amount, memo, payee_id, category_id,
            transfer_account_id, transfer_transaction_id, deleted
     FROM subtransactions
     WHERE budget_id = $1 AND deleted = false
     ORDER BY created_at, id`,
    [budgetId],
  );
  return subs.rows;
}

export interface NewTransaction {
  budgetId: string;
  accountId: string;
  date: string;
  /** Signed milliunits. */
  amount: number;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  cleared: string;
  approved: boolean;
  flag: string | null;
  repeat: string;
}

/** Insert one manual register row (flag_name NULL, not deleted). Returns the stored row. */
export async function insertTransaction(db: Queryable, t: NewTransaction) {
  const result = await db.query(
    `INSERT INTO transactions
      (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, flag_color, flag_name, repeat, deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, false)
     RETURNING *`,
    [t.budgetId, t.accountId, t.date, t.amount, t.payeeId, t.categoryId, t.memo, t.cleared, t.approved, t.flag, t.repeat],
  );
  return result.rows[0];
}

export async function getTransaction(db: Queryable, id: string) {
  return (await db.query('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];
}

/** import_ids of live rows on the account matching any LIKE pattern. */
export async function findImportIdsLike(db: Queryable, accountId: string, patterns: string[]): Promise<string[]> {
  const found = await db.query<{ import_id: string }>(
    // Prefix chars are digits/-/: so the only LIKE wildcard is the % suffix.
    'SELECT import_id FROM transactions WHERE account_id = $1 AND NOT deleted AND import_id LIKE ANY($2::text[])',
    [accountId, patterns],
  );
  return found.rows.map((r) => r.import_id);
}

export interface BulkImportRow {
  budgetId: string;
  accountId: string;
  date: string;
  amount: number;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  importId: string;
  importPayeeName: string;
  importPayeeNameOriginal: string;
}

/**
 * Statement-import (/bulk) row: uncleared, unapproved, deduped on the live
 * (account_id, import_id) index. Returns the new id, or null when the import_id
 * already exists (DO NOTHING).
 */
export async function insertBulkImportRow(db: Queryable, r: BulkImportRow): Promise<string | null> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO transactions
          (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved,
           flag_color, flag_name, repeat, deleted, import_id, import_payee_name, import_payee_name_original)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'uncleared', false, NULL, NULL, 'never', false, $8, $9, $10)
         ON CONFLICT (account_id, import_id) WHERE import_id IS NOT NULL AND NOT deleted
         DO NOTHING
         RETURNING id`,
    [
      r.budgetId,
      r.accountId,
      r.date,
      r.amount,
      r.payeeId,
      r.categoryId,
      r.memo,
      r.importId,
      r.importPayeeName,
      r.importPayeeNameOriginal,
    ],
  );
  return inserted.rows[0]?.id ?? null;
}

/** Set the payee of a row just inserted (the statement import creates a new payee only after its row is in). */
export async function setRowPayee(db: Queryable, id: string, payeeId: string | null): Promise<void> {
  await db.query('UPDATE transactions SET payee_id = $2 WHERE id = $1', [id, payeeId]);
}

/** The fields an edit needs from the live row it edits (scoped to the budget). */
export interface EditableTransaction {
  repeat_rule_id: string | null;
  occurrence_date: string | null;
  upcoming: boolean;
  account_id: string;
  amount: string;
  cleared: LedgerRow['cleared'];
  payee_id: string | null;
  category_id: string | null;
  transfer_transaction_id: string | null;
  transfer_account_id: string | null;
}

export async function getLiveTransactionInBudget(
  db: Queryable,
  id: string,
  budgetId: string,
): Promise<EditableTransaction | undefined> {
  const owned = await db.query<EditableTransaction>(
    'SELECT repeat_rule_id, occurrence_date, upcoming, account_id, amount, cleared, payee_id, category_id, transfer_transaction_id, transfer_account_id FROM transactions WHERE id = $1 AND budget_id = $2 AND deleted = false',
    [id, budgetId],
  );
  return owned.rows[0];
}

/**
 * One SET entry of a transaction UPDATE: a bound column (`col = $n`) or a
 * literal assignment. Entries render in order, so the statement text is the
 * one the route used to build by hand.
 */
export type TxnSetEntry = { col: string; value: unknown } | { raw: string };

/** `UPDATE transactions SET <entries> WHERE id = $n`; no-op for an empty list. */
export async function updateTransactionSet(db: Queryable, id: string, entries: readonly TxnSetEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const setCols: string[] = [];
  const values: unknown[] = [];
  let idx = 1;
  for (const e of entries) {
    if ('raw' in e) {
      setCols.push(e.raw);
    } else {
      setCols.push(`${e.col} = $${idx++}`);
      values.push(e.value);
    }
  }
  values.push(id);
  await db.query(`UPDATE transactions SET ${setCols.join(', ')} WHERE id = $${idx}`, values);
}

export async function softDeleteSubtransactionsOf(db: Queryable, transactionId: string): Promise<void> {
  await db.query('UPDATE subtransactions SET deleted = true WHERE transaction_id = $1', [transactionId]);
}

/** account/amount/cleared of a row as stored (balance-delta input). */
export async function getLedgerRow(db: Queryable, id: string): Promise<LedgerRow | undefined> {
  const after = await db.query<LedgerRow>('SELECT account_id, amount, cleared FROM transactions WHERE id = $1', [id]);
  return after.rows[0];
}

export type DeletedTransaction = {
  repeat_rule_id: string | null;
  occurrence_date: string | null;
  upcoming: boolean;
  transfer_transaction_id: string | null;
} & LedgerRow;

/** Soft-delete a live row of the budget; undefined when there was none. */
export async function softDeleteTransactionInBudget(
  db: Queryable,
  id: string,
  budgetId: string,
): Promise<DeletedTransaction | undefined> {
  const result = await db.query<DeletedTransaction>(
    'UPDATE transactions SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false RETURNING repeat_rule_id, occurrence_date, upcoming, account_id, amount, cleared, transfer_transaction_id',
    [id, budgetId],
  );
  return result.rows[0];
}

export interface ImportedTransaction {
  budgetId: string;
  accountId: string;
  /** ISO date (YYYY-MM-DD). */
  date: string;
  /** Signed milliunits. */
  amount: number;
  payeeId: string | null;
  importId: string;
  /** Rule-rewritten payee name, or null; stored as import_payee_name and _original. */
  importPayeeName: string | null;
  cleared: 'cleared' | 'uncleared';
}

/**
 * Bank-sync import row (connections sync): unapproved, uncategorized, no
 * memo, cleared as the bank reports it. No ON CONFLICT: the caller looked
 * the import_id up first. Returns the new id.
 */
export async function insertImportedTransaction(db: Queryable, t: ImportedTransaction): Promise<string> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO transactions
               (budget_id, account_id, date, amount, payee_id, category_id, memo,
                cleared, approved, flag_color, flag_name, repeat, deleted,
                import_id, import_payee_name, import_payee_name_original)
             VALUES ($1, $2, $3, $4, $5, NULL, NULL,
                     $8, false, NULL, NULL, 'never', false, $6, $7, $7)
             RETURNING id`,
    [t.budgetId, t.accountId, t.date, t.amount, t.payeeId, t.importId, t.importPayeeName, t.cleared],
  );
  return inserted.rows[0]!.id;
}

/** Refresh the sync-owned fields of an imported row (cleared/approved untouched; memo cleared). */
export async function refreshImportedTransaction(
  db: Queryable,
  id: string,
  f: { date: string; amount: number; payeeId: string | null; importPayeeName: string | null },
): Promise<void> {
  await db.query(
    `UPDATE transactions
           SET date = $2, amount = $3, memo = NULL, payee_id = $4,
               import_payee_name = $5, import_payee_name_original = $5
           WHERE id = $1`,
    [id, f.date, f.amount, f.payeeId, f.importPayeeName],
  );
}

/** Tombstone one row (no balance move: the caller derives and applies the delta). */
export async function tombstoneTransaction(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE public.transactions SET deleted = true WHERE id = $1', [id]);
}

/** Does the transaction exist in this budget (any state)? */
export async function transactionInBudget(db: Queryable, id: string, budgetId: string): Promise<boolean> {
  const r = await db.query('SELECT 1 FROM transactions WHERE id = $1 AND budget_id = $2', [id, budgetId]);
  return r.rowCount !== 0;
}

/** A transaction with the names of its payee, category and account, and the account's bank link. */
export interface TransactionDetailRow extends Record<string, unknown> {
  id: string;
  date: string;
  payee_name: string | null;
  category_name: string | null;
  account_name: string;
  /** The account's bank connection (budget's own column); null when not linked. */
  account_connection_id: string | null;
  /** Institution name stored on the account. */
  account_institution: string | null;
}

/**
 * One transaction of `budgetId` (live or soft-deleted) for the detail read,
 * re-scoped by budget: another budget's id is indistinguishable from a bogus one.
 */
export async function getTransactionDetailInBudget(
  db: Queryable,
  id: string,
  budgetId: string,
): Promise<TransactionDetailRow | undefined> {
  const r = await db.query<TransactionDetailRow>(
    // The second `date` (plain YYYY-MM-DD) overrides t.date in the row object.
    `SELECT t.*, to_char(t.date, 'YYYY-MM-DD') AS date,
            p.name AS payee_name, c.name AS category_name, a.name AS account_name,
            a.connection_id AS account_connection_id, a.institution AS account_institution
     FROM transactions t
     JOIN accounts a ON a.id = t.account_id AND a.budget_id = t.budget_id
     LEFT JOIN payees p ON p.id = t.payee_id
     LEFT JOIN categories c ON c.id = t.category_id
     WHERE t.id = $1 AND t.budget_id = $2`,
    [id, budgetId],
  );
  return r.rows[0];
}

/** Live split legs of one transaction of `budgetId`, with category names. */
export async function listTransactionSubtransactions(db: Queryable, transactionId: string, budgetId: string) {
  const r = await db.query(
    `SELECT s.id, s.transaction_id, s.amount, s.memo, s.payee_id, s.category_id,
            s.transfer_account_id, s.transfer_transaction_id, s.deleted, c.name AS category_name
     FROM subtransactions s
     LEFT JOIN categories c ON c.id = s.category_id
     WHERE s.transaction_id = $1 AND s.budget_id = $2 AND s.deleted = false
     ORDER BY s.created_at, s.id`,
    [transactionId, budgetId],
  );
  return r.rows;
}
