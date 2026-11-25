/**
 * Budget store: the per-account transfer payee ("Transfer : <account>").
 * SQL only; every function takes a Queryable. The rules (which payee is the
 * canonical one, how a name is chosen, what a repair does) live in
 * ../domain/transfer-payees.ts.
 */
import type { Queryable } from '../../core/db';

export interface AccountPayeeRow {
  id: string;
  budget_id: string;
  name: string;
  deleted: boolean;
  closed: boolean;
  transfer_payee_id: string | null;
  created_at: string;
}

/** A payee row with everything a lifecycle or repair step looks at. */
export interface PayeeFullRow {
  id: string;
  budget_id: string;
  name: string;
  deleted: boolean;
  hidden: boolean;
  transfer_account_id: string | null;
  created_at: string;
  rename_match_type: string | null;
  rename_condition: string | null;
  transfer_rule: string | null;
}

const PAYEE_COLUMNS = `id, budget_id, name, deleted, hidden, transfer_account_id, created_at::text AS created_at,
  rename_match_type, rename_condition, transfer_rule`;

/** The account (any state) with its transfer payee pointer; undefined when it does not exist. */
export async function getAccountRow(db: Queryable, accountId: string): Promise<AccountPayeeRow | undefined> {
  const res = await db.query<AccountPayeeRow>(
    `SELECT id, budget_id, name, deleted, closed, transfer_payee_id, created_at::text AS created_at
       FROM accounts WHERE id = $1`,
    [accountId],
  );
  return res.rows[0];
}

/** Live accounts of the budget, oldest first. */
export async function listLiveAccounts(db: Queryable, budgetId: string): Promise<AccountPayeeRow[]> {
  const res = await db.query<AccountPayeeRow>(
    `SELECT id, budget_id, name, deleted, closed, transfer_payee_id, created_at::text AS created_at
       FROM accounts WHERE budget_id = $1 AND deleted = false ORDER BY created_at, id`,
    [budgetId],
  );
  return res.rows;
}

export async function getPayeeRow(db: Queryable, budgetId: string, payeeId: string): Promise<PayeeFullRow | undefined> {
  const res = await db.query<PayeeFullRow>(`SELECT ${PAYEE_COLUMNS} FROM payees WHERE id = $1 AND budget_id = $2`, [
    payeeId,
    budgetId,
  ]);
  return res.rows[0];
}

/** The payee holding exactly `name` (any state), lock-free. */
export async function findPayeeRowByName(db: Queryable, budgetId: string, name: string): Promise<PayeeFullRow | undefined> {
  const res = await db.query<PayeeFullRow>(`SELECT ${PAYEE_COLUMNS} FROM payees WHERE budget_id = $1 AND name = $2`, [
    budgetId,
    name,
  ]);
  return res.rows[0];
}

/** Every payee of the budget pointing at the account (live or not), oldest first. */
export async function listPayeesLinkedTo(db: Queryable, budgetId: string, accountId: string): Promise<PayeeFullRow[]> {
  const res = await db.query<PayeeFullRow>(
    `SELECT ${PAYEE_COLUMNS} FROM payees
      WHERE budget_id = $1 AND transfer_account_id = $2 ORDER BY created_at, id`,
    [budgetId, accountId],
  );
  return res.rows;
}

/** Every payee of the budget, oldest first (repair scan). */
export async function listBudgetPayees(db: Queryable, budgetId: string): Promise<PayeeFullRow[]> {
  const res = await db.query<PayeeFullRow>(`SELECT ${PAYEE_COLUMNS} FROM payees WHERE budget_id = $1 ORDER BY created_at, id`, [
    budgetId,
  ]);
  return res.rows;
}

/** Ids of the live accounts of the budget named exactly `name`. */
export async function liveAccountIdsByName(db: Queryable, budgetId: string, name: string): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    'SELECT id FROM accounts WHERE budget_id = $1 AND name = $2 AND deleted = false ORDER BY created_at, id',
    [budgetId, name],
  );
  return res.rows.map((r) => r.id);
}

/** Insert a payee already linked to its account; null when the name is taken (the caller re-reads). */
export async function insertTransferPayee(
  db: Queryable,
  budgetId: string,
  name: string,
  accountId: string,
): Promise<string | null> {
  const res = await db.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name, transfer_account_id) VALUES ($1, $2, $3)
     ON CONFLICT (budget_id, name) DO NOTHING RETURNING id`,
    [budgetId, name, accountId],
  );
  return res.rows[0]?.id ?? null;
}

/** Ordinary requests: point a payee nobody links to at the account. Never un-hides or un-deletes. */
export async function adoptPayee(db: Queryable, payeeId: string, accountId: string): Promise<boolean> {
  const res = await db.query('UPDATE payees SET transfer_account_id = $2 WHERE id = $1 AND transfer_account_id IS NULL', [payeeId, accountId]);
  return (res.rowCount ?? 0) > 0;
}

/** Repair only: make the payee the account's transfer payee: linked, live and visible. */
export async function linkPayeeToAccount(db: Queryable, payeeId: string, accountId: string): Promise<void> {
  await db.query('UPDATE payees SET transfer_account_id = $2, deleted = false, hidden = false WHERE id = $1', [payeeId, accountId]);
}

export async function setAccountTransferPayee(db: Queryable, accountId: string, payeeId: string): Promise<void> {
  await db.query('UPDATE accounts SET transfer_payee_id = $2 WHERE id = $1', [accountId, payeeId]);
}

/**
 * Rename a payee; false when the name was taken in the meantime (a concurrent
 * insert). A savepoint keeps the caller's transaction alive after the unique
 * violation, so it must run inside one.
 */
export async function trySetPayeeName(db: Queryable, payeeId: string, name: string): Promise<boolean> {
  await db.query('SAVEPOINT transfer_payee_rename');
  try {
    await db.query('UPDATE payees SET name = $2 WHERE id = $1', [payeeId, name]);
    await db.query('RELEASE SAVEPOINT transfer_payee_rename');
    return true;
  } catch (err) {
    if ((err as { code?: string }).code !== '23505') throw err;
    await db.query('ROLLBACK TO SAVEPOINT transfer_payee_rename');
    await db.query('RELEASE SAVEPOINT transfer_payee_rename');
    return false;
  }
}

/** Every column that references payees(id), as [table, column]. `transfer_links.prev_payee_id` has no FK but is a payee id. */
const PAYEE_REFERENCES = [
  ['transactions', 'payee_id'],
  ['subtransactions', 'payee_id'],
  ['scheduled_transactions', 'payee_id'],
  ['scheduled_subtransactions', 'payee_id'],
  ['txn_repeat_rules', 'payee_id'],
  ['transfer_links', 'prev_payee_id'],
] as const;

/**
 * Re-point every reference to payee `fromId` at `toId` within ONE budget
 * (live and deleted rows alike, every statement scoped by budget_id); returns
 * how many `transactions` rows moved, including the account pointers.
 */
export async function repointPayeeReferences(db: Queryable, budgetId: string, fromId: string, toId: string): Promise<number> {
  let moved = 0;
  for (const [table, column] of PAYEE_REFERENCES) {
    const res = await db.query(`UPDATE ${table} SET ${column} = $2 WHERE ${column} = $1 AND budget_id = $3`, [fromId, toId, budgetId]);
    if (table === 'transactions') moved = res.rowCount ?? 0;
  }
  await db.query('UPDATE accounts SET transfer_payee_id = $2 WHERE transfer_payee_id = $1 AND budget_id = $3', [fromId, toId, budgetId]);
  return moved;
}

/** How many transactions reference each payee (repair report). */
export async function countTransactionsByPayee(db: Queryable, payeeIds: readonly string[]): Promise<Map<string, number>> {
  if (payeeIds.length === 0) return new Map();
  const res = await db.query<{ payee_id: string; n: number }>(
    'SELECT payee_id, count(*)::int AS n FROM transactions WHERE payee_id = ANY($1::uuid[]) GROUP BY payee_id',
    [payeeIds],
  );
  return new Map(res.rows.map((r) => [r.payee_id, r.n]));
}

/** Drop the payee's renaming rule (the unique index is per budget and condition). */
export async function clearRenameRule(db: Queryable, payeeId: string): Promise<void> {
  await db.query('UPDATE payees SET rename_match_type = NULL, rename_condition = NULL WHERE id = $1', [payeeId]);
}

export async function setRenameRule(db: Queryable, payeeId: string, matchType: string, condition: string): Promise<void> {
  await db.query('UPDATE payees SET rename_match_type = $2, rename_condition = $3 WHERE id = $1', [payeeId, matchType, condition]);
}

/** Copy the "treat as transfer" rule columns from one payee to another. */
export async function copyTransferRule(db: Queryable, fromId: string, toId: string): Promise<void> {
  await db.query(
    `UPDATE payees t SET transfer_rule = f.transfer_rule, transfer_rule_account_id = f.transfer_rule_account_id,
            transfer_rule_no_match = f.transfer_rule_no_match, transfer_rule_wait_days = f.transfer_rule_wait_days,
            transfer_rule_since = f.transfer_rule_since
       FROM payees f WHERE f.id = $1 AND t.id = $2`,
    [fromId, toId],
  );
}

/** Repair only: hard-delete a payee nothing references any more (its name becomes free). */
export async function deletePayeeRow(db: Queryable, budgetId: string, payeeId: string): Promise<void> {
  await db.query('DELETE FROM payees WHERE id = $1 AND budget_id = $2', [payeeId, budgetId]);
}
