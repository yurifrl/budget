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

// Transaction counts + last-used date per payee, one scan over live txns.
const listStats = `
  left join lateral (
    select count(*)::int as txn_count, max(date) as last_used_date
    from transactions t
    where t.payee_id = p.id and t.deleted = false
  ) s on true
`;

// Inferred default category (syscd-app-7pa): strict majority of the payee's
// last 3 categorized live transactions; null when the last 3 disagree or
// none are categorized. Computed in the same pass — no per-payee queries.
const inferredStats = `
  left join lateral (
    select m.category_id as inferred_category_id
    from (
      select r.category_id, count(*) as n, r.total
      from (
        select category_id, count(*) over () as total
        from (
          select t.category_id
          from transactions t
          where t.payee_id = p.id and t.deleted = false and t.category_id is not null
          order by t.date desc, t.id desc
          limit 3
        ) last3
      ) r
      group by r.category_id, r.total
    ) m
    where m.n * 2 > m.total
    limit 1
  ) inf on true
  left join categories ic on ic.id = inf.inferred_category_id
`;

/**
 * Live payees with usage stats and the inferred category; `hidden` filters.
 * Account transfer payees ("Transfer : <account>") are listed only when
 * `includeTransfers` is set, each carrying its account's current name.
 */
export async function listPayees(db: Queryable, budgetId: string, hidden: string | undefined, includeTransfers = false) {
  // `hidden` filter: absent = all live payees (with flag), 'false' = pickers
  // (visible only), 'true' = hidden only.
  const hiddenClause = hidden === 'true' ? 'AND p.hidden = true' : hidden === 'false' ? 'AND p.hidden = false' : '';
  const transferClause = includeTransfers ? '' : 'AND p.transfer_account_id IS NULL';
  const result = await db.query(
    `SELECT p.id, p.name, p.transfer_account_id, p.deleted, p.hidden,
              p.categorization_mode, p.default_category_id,
              p.rename_match_type, p.rename_condition,
              CASE WHEN p.transfer_rule IN ('auto','account','never') THEN p.transfer_rule END AS transfer_rule,
              p.transfer_rule_account_id,
              ta.name AS transfer_account_name,
              coalesce(s.txn_count, 0) as transaction_count, s.last_used_date,
              inf.inferred_category_id, ic.name as inferred_category_name
       FROM payees p
       LEFT JOIN accounts ta ON ta.id = p.transfer_account_id AND ta.budget_id = p.budget_id AND ta.deleted = false
       ${listStats} ${inferredStats}
       WHERE p.budget_id = $1 AND p.deleted = false ${transferClause} ${hiddenClause}
       ORDER BY p.name`,
    [budgetId],
  );
  return result.rows;
}

/** Live payee of the budget? */
export async function livePayeeExists(db: Queryable, budgetId: string, id: string): Promise<boolean> {
  const result = await db.query('SELECT 1 FROM payees WHERE id = $1 AND budget_id = $2 AND deleted = false', [id, budgetId]);
  return result.rowCount !== 0;
}

/** Create-or-find by name with the create-form fields. */
export async function insertPayee(
  db: Queryable,
  p: { budgetId: string; name: string; defaultCategoryId: string | null; hidden: boolean; categorizationMode: string },
) {
  const result = await db.query(
    `INSERT INTO payees (budget_id, name, default_category_id, hidden, categorization_mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
       RETURNING id, name, transfer_account_id, deleted, hidden, categorization_mode, default_category_id`,
    [p.budgetId, p.name, p.defaultCategoryId, p.hidden, p.categorizationMode],
  );
  return result.rows[0];
}

/** One page of a payee's live transactions plus the total count. */
export async function payeeTransactionsPage(db: Queryable, id: string, budgetId: string, limit: number, offset: number) {
  const where = 'WHERE t.payee_id = $1 AND t.budget_id = $2 AND t.deleted = false';
  const [rows, totals] = await Promise.all([
    db.query(
      `SELECT t.id, t.date::text as date, t.amount, t.memo, t.cleared::text as cleared,
                t.account_id, a.name as account_name,
                t.category_id, cat.name as category_name,
                t.payee_id
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
         LEFT JOIN categories cat ON cat.id = t.category_id
         ${where}
         ORDER BY t.date DESC, t.id DESC
         LIMIT $3 OFFSET $4`,
      [id, budgetId, limit, offset],
    ),
    db.query<{ total: number }>(`SELECT count(*)::int as total FROM transactions t ${where}`, [id, budgetId]),
  ]);
  return { rows: rows.rows, total: totals.rows[0]?.total ?? 0 };
}

export interface PayeeNameHolder {
  name: string;
  deleted: boolean;
  transfer: boolean;
}

/** Another payee holding `name` (case-insensitive among live ones, exact among all); live first. */
export async function findPayeeNameClash(db: Queryable, budgetId: string, id: string, name: string) {
  const clash = await db.query<PayeeNameHolder>(
    `SELECT name, deleted, transfer_account_id IS NOT NULL AS transfer FROM payees
       WHERE budget_id = $1 AND id <> $2 AND ((deleted = false AND lower(name) = lower($3)) OR name = $3)
       ORDER BY deleted, name = $3 DESC LIMIT 1`,
    [budgetId, id, name],
  );
  return clash.rows[0];
}

/** The payee holding exactly `name` (after a unique violation). */
export async function findPayeeByExactName(db: Queryable, budgetId: string, name: string) {
  const taken = await db.query<PayeeNameHolder>(
    `SELECT name, deleted, transfer_account_id IS NOT NULL AS transfer
           FROM payees WHERE budget_id = $1 AND name = $2`,
    [budgetId, name],
  );
  return taken.rows[0];
}

/** Rename a live payee; false when none matched. Unique violations propagate. */
export async function renamePayee(db: Queryable, id: string, budgetId: string, name: string): Promise<boolean> {
  const result = await db.query('UPDATE payees SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    name,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

export async function setPayeeHidden(db: Queryable, id: string, budgetId: string, hidden: boolean): Promise<boolean> {
  const result = await db.query('UPDATE payees SET hidden = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false', [
    hidden,
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

/** Set categorization mode and/or default category (only the given fields). */
export async function setPayeeCategorization(
  db: Queryable,
  id: string,
  budgetId: string,
  f: { categorizationMode?: string; defaultCategoryId?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (f.categorizationMode !== undefined) {
    sets.push(`categorization_mode = $${values.length + 1}`);
    values.push(f.categorizationMode);
  }
  if (f.defaultCategoryId !== undefined) {
    sets.push(`default_category_id = $${values.length + 1}`);
    values.push(f.defaultCategoryId);
  }
  if (sets.length > 0) {
    values.push(id, budgetId);
    await db.query(
      `UPDATE payees SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND budget_id = $${values.length}`,
      values,
    );
  }
}

export async function softDeletePayee(db: Queryable, id: string, budgetId: string): Promise<boolean> {
  const result = await db.query('UPDATE payees SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false', [
    id,
    budgetId,
  ]);
  return result.rowCount !== 0;
}

/** Lock the live payees among `ids` in the budget (merge). */
export async function lockLivePayees(db: Queryable, ids: string[], budgetId: string) {
  const rows = await db.query<{ id: string; name: string; transfer_account_id: string | null }>(
    `SELECT id, name, transfer_account_id FROM payees
         WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false
         FOR UPDATE`,
    [ids, budgetId],
  );
  return rows.rows;
}

/** Re-point live transactions of `fromId` to `toId`; returns how many moved. */
export async function movePayeeTransactions(db: Queryable, fromId: string, toId: string): Promise<number> {
  const merged = await db.query('UPDATE transactions SET payee_id = $1 WHERE payee_id = $2 AND deleted = false', [toId, fromId]);
  return merged.rowCount ?? 0;
}

export async function markPayeeDeleted(db: Queryable, id: string): Promise<void> {
  await db.query('UPDATE payees SET deleted = true WHERE id = $1', [id]);
}

/** Set (or with nulls, clear) the payee's rename rule; false when no live payee matched. */
export async function setPayeeRenameRule(
  db: Queryable,
  id: string,
  budgetId: string,
  matchType: string | null,
  condition: string | null,
): Promise<boolean> {
  const result = await db.query(
    'UPDATE payees SET rename_match_type = $3, rename_condition = $4 WHERE id = $1 AND budget_id = $2 AND deleted = false',
    [id, budgetId, matchType, condition],
  );
  return result.rowCount !== 0;
}

/** categorization_mode of a live payee of the budget; undefined when there is none. */
export async function getPayeeCategorizationMode(db: Queryable, id: string, budgetId: string) {
  const payee = await db.query<{ categorization_mode: 'auto' | 'fixed' | 'never' }>(
    'SELECT categorization_mode FROM payees WHERE id = $1 AND budget_id = $2 AND deleted = false',
    [id, budgetId],
  );
  return payee.rows[0]?.categorization_mode;
}
