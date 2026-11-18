import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { normalizeBundles } from '../domain/bundles';
import { groupsCreate, groupsDelete, groupsList, groupsRename } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

export const operations = [
  implement(groupsList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT * FROM category_groups WHERE budget_id = $1 AND deleted = false ORDER BY sort_order',
      [budget_id],
    );
    return result.rows;
  }),

  implement(groupsCreate, async (_c, { budget_id, name }) => {
    // Sort after the last existing group; the client never needs to compute it.
    const result = await pool.query(
      `INSERT INTO category_groups (budget_id, name, sort_order)
       VALUES ($1, $2, COALESCE((SELECT MAX(sort_order) + 1 FROM category_groups WHERE budget_id = $1), 0))
       RETURNING *`,
      [budget_id, name],
    );
    return result.rows[0];
  }),

  implement(groupsRename, async (_c, { id, budget_id, name }) => {
    const result = await pool.query(
      'UPDATE category_groups SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [name, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category group not found');
  }),

  implement(groupsDelete, async (_c, { id, budget_id }) => {
    const result = await pool.query(
      'UPDATE category_groups SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category group not found');
    // YNAB semantics: deleting a group removes the whole group — tombstone its
    // live categories too (soft deletes keep assignment/transaction history).
    await pool.query(
      'UPDATE categories SET deleted = true WHERE group_id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id],
    );
    await normalizeBundles(pool, budget_id);
  }),
];

export default budgetRouter('/groups', operations);
