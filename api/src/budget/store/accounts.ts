/**
 * Budget store: accounts. SQL only (moved verbatim from the route files);
 * every function takes a Queryable (pool or transaction client).
 */
import type { Queryable } from '../../core/db';
import type { AccountType } from '@shared/contracts/budget/schemas';
import { personRefSql, type PersonRefRow } from '../../user';

/** `closed` of an account that belongs to `budgetId`; undefined when it does not exist there. */
export async function findAccountInBudget(
  db: Queryable,
  accountId: string,
  budgetId: string,
): Promise<{ closed: boolean } | undefined> {
  const r = await db.query<{ closed: boolean }>('SELECT closed FROM accounts WHERE id = $1 AND budget_id = $2', [
    accountId,
    budgetId,
  ]);
  return r.rows[0];
}

/** Live accounts of a budget with the linking user's person-ref columns (LEFT JOIN connections/users). */
export async function listAccountsWithLinker(db: Queryable, budgetId: string) {
  const result = await db.query<PersonRefRow & Record<string, unknown>>(
    `SELECT a.*, ${personRefSql('u')}
         FROM accounts a
         LEFT JOIN connections c ON c.id = a.connection_id
         LEFT JOIN users u ON u.id = c.user_id
        WHERE a.budget_id = $1 AND a.deleted = false
        ORDER BY a.sort_order`,
    [budgetId],
  );
  return result.rows;
}

export async function budgetExists(db: Queryable, budgetId: string): Promise<boolean> {
  const budgetCheck = await db.query('SELECT 1 FROM budgets WHERE id = $1', [budgetId]);
  return budgetCheck.rowCount !== 0;
}

export async function getAccount(db: Queryable, accountId: string) {
  const row = await db.query('SELECT * FROM accounts WHERE id = $1', [accountId]);
  return row.rows[0];
}

export async function insertAccount(
  db: Queryable,
  a: { budgetId: string; name: string; type: AccountType; accountGroup: 'CASH' | 'CREDIT'; onBudget: boolean; userId: string | null },
): Promise<string> {
  const created = await db.query<{ id: string }>(
    `INSERT INTO accounts (budget_id, name, type, account_group, on_budget, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
    [a.budgetId, a.name, a.type, a.accountGroup, a.onBudget, a.userId],
  );
  return created.rows[0].id;
}

/** The Credit Card Payments group of a budget (first live one), if any. */
export async function findCardPaymentsGroup(db: Queryable, budgetId: string): Promise<string | undefined> {
  return (
    await db.query<{ id: string }>(
      `SELECT id FROM category_groups
        WHERE budget_id = $1 AND is_credit_card_payments AND NOT deleted
        ORDER BY sort_order, created_at LIMIT 1`,
      [budgetId],
    )
  ).rows[0]?.id;
}

export async function insertCardPaymentsGroup(db: Queryable, budgetId: string): Promise<string> {
  return (
    await db.query<{ id: string }>(
      `INSERT INTO category_groups (budget_id, name, sort_order, is_credit_card_payments, internal)
         VALUES ($1, 'Credit Card Payments', 0, true, true) RETURNING id`,
      [budgetId],
    )
  ).rows[0]!.id;
}

/** Insert the card's payment category unless a live one with that name exists in the group. */
export async function insertCardPaymentCategoryIfMissing(
  db: Queryable,
  budgetId: string,
  groupId: string,
  name: string,
): Promise<void> {
  await db.query(
    `INSERT INTO categories (budget_id, group_id, name, sort_order)
     SELECT $1, $2, $3, COALESCE((SELECT MAX(sort_order) + 1 FROM categories WHERE group_id = $2), 0)
      WHERE NOT EXISTS (SELECT 1 FROM categories WHERE group_id = $2 AND name = $3 AND NOT deleted)`,
    [budgetId, groupId, name],
  );
}

/** Opening-balance transaction of a new account (uncleared, approved, today). */
export async function insertOpeningBalanceTransaction(
  db: Queryable,
  budgetId: string,
  accountId: string,
  payeeId: string,
  amountMilli: number,
): Promise<void> {
  await db.query(
    `INSERT INTO transactions
          (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat, deleted)
         VALUES ($1, $2, CURRENT_DATE, $3, NULL, '', $4, 'uncleared', true, 'never', false)`,
    [budgetId, accountId, payeeId, amountMilli],
  );
}

export async function setUnclearedBalance(db: Queryable, accountId: string, milli: number): Promise<void> {
  await db.query('UPDATE accounts SET uncleared_balance = $1 WHERE id = $2', [milli, accountId]);
}

export async function getAccountForUpdateCheck(db: Queryable, accountId: string) {
  const accResult = await db.query<{ budget_id: string; closed: boolean; name: string; type: AccountType; on_budget: boolean }>(
    'SELECT budget_id, closed, name, type, on_budget FROM accounts WHERE id = $1',
    [accountId],
  );
  return accResult.rows[0];
}

export async function getAccountBalances(db: Queryable, accountId: string) {
  const current = await db.query<{ cleared_balance: string; uncleared_balance: string }>(
    'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
    [accountId],
  );
  return current.rows[0];
}

export async function addToUnclearedBalance(db: Queryable, accountId: string, diffMilli: number): Promise<void> {
  await db.query('UPDATE accounts SET uncleared_balance = uncleared_balance + $1 WHERE id = $2', [diffMilli, accountId]);
}

/** Set `closed`, keeping account_group in step (0004 sync invariant). */
export async function setAccountClosed(db: Queryable, accountId: string, closed: boolean): Promise<void> {
  await db.query(
    "UPDATE accounts SET closed = $2, account_group = CASE WHEN $2 THEN 'CLOSED'::account_group ELSE CASE WHEN type IN ('creditCard','lineOfCredit') THEN 'CREDIT'::account_group ELSE 'CASH'::account_group END END WHERE id = $1",
    [accountId, closed],
  );
}

/** Rename the name-linked card payment category (live, in the CCP group, no clash). */
export async function renameCardPaymentCategory(db: Queryable, budgetId: string, oldName: string, newName: string): Promise<void> {
  await db.query(
    `UPDATE categories c SET name = $3
             FROM category_groups g
            WHERE g.id = c.group_id AND g.is_credit_card_payments AND c.budget_id = $1
              AND c.name = $2 AND NOT c.deleted
              AND NOT EXISTS (SELECT 1 FROM categories x WHERE x.group_id = c.group_id AND x.name = $3 AND NOT x.deleted)`,
    [budgetId, oldName, newName],
  );
}

export async function setAccountNameNote(db: Queryable, accountId: string, name: string | null, note: string | null): Promise<void> {
  await db.query('UPDATE accounts SET name = COALESCE($2, name), note = $3 WHERE id = $1', [accountId, name, note]);
}

export async function setAccountUser(db: Queryable, accountId: string, userId: string | null): Promise<void> {
  await db.query('UPDATE accounts SET user_id = $2 WHERE id = $1', [accountId, userId]);
}

export async function unlinkAccount(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    'UPDATE accounts SET connection_id = NULL, external_account_id = NULL, institution = NULL WHERE id = $1',
    [accountId],
  );
}

/** Other live accounts already linked to this upstream account (strict 1:1 check). */
export async function findOtherAccountLinkedTo(
  db: Queryable,
  accountId: string,
  connectionId: string,
  externalAccountId: string,
): Promise<boolean> {
  const taken = await db.query<{ id: string }>(
    `SELECT id FROM accounts
            WHERE connection_id = $2 AND external_account_id = $3 AND id <> $1 AND NOT deleted`,
    [accountId, connectionId, externalAccountId],
  );
  return taken.rows.length > 0;
}

export async function linkAccount(
  db: Queryable,
  accountId: string,
  connectionId: string,
  externalAccountId: string,
  institution: string | null,
): Promise<void> {
  await db.query(
    'UPDATE accounts SET connection_id = $2, external_account_id = $3, institution = $4 WHERE id = $1',
    [accountId, connectionId, externalAccountId, institution],
  );
}

export async function getAccountBudgetClosed(db: Queryable, accountId: string) {
  const accResult = await db.query<{
    budget_id: string;
    closed: boolean;
  }>('SELECT budget_id, closed FROM accounts WHERE id = $1', [accountId]);
  return accResult.rows[0];
}

/** Mark every live, not-yet-reconciled row of the account reconciled. */
export async function reconcileAccountTransactions(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    "UPDATE transactions SET cleared = 'reconciled' WHERE account_id = $1 AND deleted = false AND cleared <> 'reconciled'",
    [accountId],
  );
}

/** Fold uncleared into cleared and stamp last_reconciled_at (totals unchanged). */
export async function foldUnclearedIntoCleared(db: Queryable, accountId: string): Promise<void> {
  await db.query(
    'UPDATE accounts SET cleared_balance = cleared_balance + uncleared_balance, uncleared_balance = 0, last_reconciled_at = NOW() WHERE id = $1',
    [accountId],
  );
}

/** Ledger sum of live rows (not deleted, not upcoming), milliunits. */
export async function ledgerSum(db: Queryable, accountId: string): Promise<number> {
  const sumResult = await db.query<{ total: string }>(
    'SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE account_id = $1 AND NOT deleted AND NOT upcoming',
    [accountId],
  );
  return Number(sumResult.rows[0].total);
}

export async function insertReconciliationAdjustment(
  db: Queryable,
  budgetId: string,
  accountId: string,
  payeeId: string,
  diffMilli: number,
): Promise<void> {
  await db.query(
    `INSERT INTO transactions
          (budget_id, account_id, date, payee_id, category_id, memo, amount, cleared, approved, repeat, deleted)
         VALUES ($1, $2, CURRENT_DATE, $3, NULL, 'auto', $4, 'reconciled', true, 'never', false)`,
    [budgetId, accountId, payeeId, diffMilli],
  );
}

export async function setReconciledBalance(db: Queryable, accountId: string, statedMilli: number): Promise<void> {
  await db.query('UPDATE accounts SET cleared_balance = $1, uncleared_balance = 0, last_reconciled_at = NOW() WHERE id = $2', [
    statedMilli,
    accountId,
  ]);
}

export async function lockLiveAccount(db: Queryable, accountId: string) {
  return (
    await db.query<{ budget_id: string; closed: boolean; name: string; transfer_payee_id: string | null }>(
      'SELECT budget_id, closed, name, transfer_payee_id FROM accounts WHERE id = $1 AND deleted = false FOR UPDATE',
      [accountId],
    )
  ).rows[0];
}

export async function softDeleteAccountTransactions(db: Queryable, accountId: string): Promise<void> {
  await db.query('UPDATE transactions SET deleted = true WHERE account_id = $1 AND deleted = false', [accountId]);
}

/** Retire repeat rules homed on the account or targeting its transfer payee. */
export async function retireAccountRepeatRules(db: Queryable, accountId: string, transferPayeeId: string | null): Promise<void> {
  await db.query(
    `UPDATE txn_repeat_rules SET deleted = true
       WHERE deleted = false AND (account_id = $1 OR payee_id = $2)`,
    [accountId, transferPayeeId],
  );
}

export async function zeroAndDeleteAccount(db: Queryable, accountId: string): Promise<void> {
  await db.query('UPDATE accounts SET cleared_balance = 0, uncleared_balance = 0, deleted = true WHERE id = $1', [
    accountId,
  ]);
}
