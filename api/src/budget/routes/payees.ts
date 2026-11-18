import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { applyRules, type RenameRule } from '@shared/domain/payees';
import {
  payeesCreate,
  payeesDelete,
  payeesList,
  payeesMerge,
  payeesRename,
  payeesSetCategorization,
  payeesSetHidden,
  payeesSetRenameRule,
  payeesTransactions,
} from '@shared/contracts/budget';
import { budgetRouter } from '../router';

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

const PAYEE_NAME_UNIQUE = 'payees_budget_id_name_key';

interface NameHolder {
  name: string;
  deleted: boolean;
  transfer: boolean;
}

/** 409 naming the payee that already holds the name. Merge is only offered when it can work. */
function payeeNameConflict(other: NameHolder): HttpError {
  if (other.transfer) {
    return new HttpError(409, `The name "${other.name}" is reserved for a transfer payee. Choose a different name.`);
  }
  if (other.deleted) {
    return new HttpError(409, `A deleted payee is already named "${other.name}". Choose a different name.`);
  }
  return new HttpError(
    409,
    `A payee named "${other.name}" already exists. Choose a different name, or use Merge to combine them.`,
  );
}

async function requirePayee(budgetId: string, id: string): Promise<void> {
  const result = await pool.query(
    'SELECT 1 FROM payees WHERE id = $1 AND budget_id = $2 AND deleted = false',
    [id, budgetId],
  );
  if (result.rowCount === 0) throw new HttpError(404, 'payee not found');
}

export const operations = [
  implement(payeesList, async (_c, { budget_id, hidden }) => {
    // `hidden` filter: absent = all live payees (with flag), 'false' = pickers
    // (visible only), 'true' = hidden only. Transfer payees never list.
    const hiddenClause =
      hidden === 'true' ? 'AND p.hidden = true' : hidden === 'false' ? 'AND p.hidden = false' : '';
    const result = await pool.query(
      `SELECT p.id, p.name, p.transfer_account_id, p.deleted, p.hidden,
              p.categorization_mode, p.default_category_id,
              p.rename_match_type, p.rename_condition,
              coalesce(s.txn_count, 0) as transaction_count, s.last_used_date,
              inf.inferred_category_id, ic.name as inferred_category_name
       FROM payees p ${listStats} ${inferredStats}
       WHERE p.budget_id = $1 AND p.deleted = false AND p.transfer_account_id IS NULL ${hiddenClause}
       ORDER BY p.name`,
      [budget_id],
    );
    return result.rows;
  }),

  implement(payeesCreate, async (_c, { budget_id, name, default_category_id, hidden, categorization_mode }) => {
    if (default_category_id) {
      const cat = await pool.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [
        default_category_id,
        budget_id,
      ]);
      if (cat.rowCount === 0) throw new HttpError(400, 'category not found in budget');
    }
    // Rule-aware create: a name matching a payee's rename condition lands as
    // that payee's name, mirroring what transaction creation would do.
    const rules = await pool.query<RenameRule>(
      `SELECT name as replacement, rename_match_type as match_type, rename_condition as condition
       FROM payees WHERE budget_id = $1 AND deleted = false AND rename_condition IS NOT NULL
       ORDER BY created_at`,
      [budget_id],
    );
    const effectiveName = applyRules(rules.rows, name);
    const result = await pool.query(
      `INSERT INTO payees (budget_id, name, default_category_id, hidden, categorization_mode)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
       RETURNING id, name, transfer_account_id, deleted, hidden, categorization_mode, default_category_id`,
      [budget_id, effectiveName, default_category_id ?? null, hidden ?? false, categorization_mode ?? 'auto'],
    );
    return result.rows[0];
  }),

  // GET /:id/transactions?budget_id=… — paginated ledger for one payee.
  implement(payeesTransactions, async (_c, { id, budget_id, limit, offset }) => {
    await requirePayee(budget_id, id);
    const where = 'WHERE t.payee_id = $1 AND t.budget_id = $2 AND t.deleted = false';
    const [rows, totals] = await Promise.all([
      pool.query(
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
        [id, budget_id, limit, offset],
      ),
      pool.query<{ total: number }>(
        `SELECT count(*)::int as total FROM transactions t ${where}`,
        [id, budget_id],
      ),
    ]);
    return { rows: rows.rows, total: totals.rows[0]?.total ?? 0 };
  }),

  implement(payeesRename, async (_c, { id, budget_id, name }) => {
    await requirePayee(budget_id, id);
    // Case-insensitive pre-check for a friendly message (the DB constraint is
    // case-sensitive, so it can't catch "ifood" vs "iFood"). The payee itself is
    // excluded so a case-only rename of the same payee ("ifood" -> "iFood") works.
    const clash = await pool.query<NameHolder>(
      `SELECT name, deleted, transfer_account_id IS NOT NULL AS transfer FROM payees
       WHERE budget_id = $1 AND id <> $2 AND ((deleted = false AND lower(name) = lower($3)) OR name = $3)
       ORDER BY deleted, name = $3 DESC LIMIT 1`,
      [budget_id, id, name],
    );
    if (clash.rows[0]) throw payeeNameConflict(clash.rows[0]);
    // The payee must belong to this budget and not be tombstoned; otherwise the
    // update would silently rename another budget's row.
    let result;
    try {
      result = await pool.query(
        'UPDATE payees SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
        [name, id, budget_id],
      );
    } catch (err) {
      // A concurrent request can win the race between the check above and this
      // UPDATE: the unique constraint is the source of truth, so map it to 409.
      const pgErr = err as { code?: string; constraint?: string };
      if (pgErr.code === '23505' && pgErr.constraint === PAYEE_NAME_UNIQUE) {
        const taken = await pool.query<NameHolder>(
          `SELECT name, deleted, transfer_account_id IS NOT NULL AS transfer
           FROM payees WHERE budget_id = $1 AND name = $2`,
          [budget_id, name],
        );
        throw payeeNameConflict(taken.rows[0] ?? { name, deleted: false, transfer: false });
      }
      throw err;
    }
    if (result.rowCount === 0) throw new HttpError(404, 'payee not found');
  }),

  implement(payeesSetHidden, async (_c, { id, budget_id, hidden }) => {
    const result = await pool.query(
      'UPDATE payees SET hidden = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [hidden, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'payee not found');
  }),

  implement(payeesSetCategorization, async (_c, { id, budget_id, categorization_mode, default_category_id }) => {
    await requirePayee(budget_id, id);
    if (default_category_id) {
      const cat = await pool.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [
        default_category_id,
        budget_id,
      ]);
      if (cat.rowCount === 0) throw new HttpError(400, 'category not found in budget');
    }
    const sets: string[] = [];
    const values: unknown[] = [];
    if (categorization_mode !== undefined) {
      sets.push(`categorization_mode = $${values.length + 1}`);
      values.push(categorization_mode);
    }
    if (default_category_id !== undefined) {
      sets.push(`default_category_id = $${values.length + 1}`);
      values.push(default_category_id);
    }
    if (sets.length > 0) {
      values.push(id, budget_id);
      await pool.query(
        `UPDATE payees SET ${sets.join(', ')} WHERE id = $${values.length - 1} AND budget_id = $${values.length}`,
        values,
      );
    }
  }),

  // Soft-delete only: transactions keep their payee_id, so a hard delete would
  // orphan them — the UI offers merge instead.
  implement(payeesDelete, async (_c, { id, budget_id }) => {
    const result = await pool.query(
      'UPDATE payees SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'payee not found');
  }),

  /**
   * Merge: every transaction of the source payee re-points to the target
   * (same budget, live), then the source is soft-deleted — matching the issue
   * spec ("source payee txns re-pointed to target, source soft-deleted").
   */
  implement(payeesMerge, async (_c, { id, budget_id, target_id }) => {
    if (target_id === id) throw new HttpError(400, 'cannot merge a payee into itself');

    return withTransaction(pool, async (client) => {
      const rows = await client.query<{ id: string; name: string }>(
        `SELECT id, name FROM payees
         WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false
         FOR UPDATE`,
        [[id, target_id], budget_id],
      );
      if (!rows.rows.some((r) => r.id === id)) throw new HttpError(404, 'payee not found');
      if (!rows.rows.some((r) => r.id === target_id)) throw new HttpError(404, 'target payee not found');

      const merged = await client.query(
        'UPDATE transactions SET payee_id = $1 WHERE payee_id = $2 AND deleted = false',
        [target_id, id],
      );
      await client.query('UPDATE payees SET deleted = true WHERE id = $1', [id]);
      return { merged_transactions: merged.rowCount ?? 0, source_deleted: true };
    });
  }),

  // per-payee renaming rule (the payee's own name is the rename target)
  implement(payeesSetRenameRule, async (_c, { id, budget_id, match_type, condition }) => {
    // Empty condition clears the rule (one rule per payee; deleting = clearing).
    const result = await pool.query(
      'UPDATE payees SET rename_match_type = $3, rename_condition = $4 WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id, condition === '' ? null : match_type, condition === '' ? null : condition],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'payee not found');
  }),
];

export default budgetRouter('/payees', operations);
