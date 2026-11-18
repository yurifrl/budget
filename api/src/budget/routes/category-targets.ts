/**
 * Category target routes — get/put/delete per category (bead syscd-app-nc5).
 *
 * One target per category (unique category_id). PUT upserts, DELETE removes.
 * All money is integer cents (engine units, not YNAB milliunits).
 */

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError, parseValue } from '../../core/validate';
import { categoryTargetsDelete, categoryTargetsList, categoryTargetsSet } from '@shared/contracts/budget';
import { targetConfigSchemas } from '@shared/contracts/budget/schemas';
import { budgetRouter } from '../router';

export const operations = [
  /** List all targets for a budget. */
  implement(categoryTargetsList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT * FROM category_targets WHERE budget_id = $1 ORDER BY category_id',
      [budget_id],
    );
    return result.rows;
  }),

  /** Upsert the target for one category. */
  implement(categoryTargetsSet, async (_c, { categoryId, budget_id, kind, amount_cents, snooze_month, config: rawConfig }) => {
    const config = parseValue(targetConfigSchemas[kind], rawConfig);

    const cat = await pool.query(
      'SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [categoryId, budget_id],
    );
    if (cat.rowCount === 0) throw new HttpError(404, 'category not found');

    const result = await pool.query(
      `INSERT INTO category_targets (budget_id, category_id, kind, amount_cents, snooze_month, config)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (category_id) DO UPDATE
         SET kind = EXCLUDED.kind,
             amount_cents = EXCLUDED.amount_cents,
             snooze_month = EXCLUDED.snooze_month,
             config = EXCLUDED.config,
             updated_at = now()
       RETURNING *`,
      [budget_id, categoryId, kind, amount_cents, snooze_month ?? null, JSON.stringify(config)],
    );
    return result.rows[0];
  }),

  /** Remove the target for one category. */
  implement(categoryTargetsDelete, async (_c, { categoryId, budget_id }) => {
    const result = await pool.query(
      'DELETE FROM category_targets WHERE category_id = $1 AND budget_id = $2',
      [categoryId, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'target not found');
  }),
];

export default budgetRouter('/category-targets', operations);
