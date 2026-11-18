import type { PoolClient } from 'pg';

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { bundlesCreate, bundlesDelete, bundlesList, bundlesRename, categoriesSetBundle } from '@shared/contracts/budget';
import { normalizeBundles } from '../domain/bundles';
import { budgetRouter } from '../router';

/** Move categories into `groupId` (appended) and set their bundle, in the caller's transaction. */
async function assignCategories(
  client: PoolClient,
  budgetId: string,
  groupId: string,
  bundleId: string,
  categoryIds: string[],
): Promise<void> {
  const found = await client.query<{ id: string; group_id: string }>(
    'SELECT id, group_id FROM categories WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false',
    [categoryIds, budgetId],
  );
  if (found.rowCount !== categoryIds.length) throw new HttpError(404, 'category not found');
  let next = Number(
    (
      await client.query<{ n: number }>(
        'SELECT COALESCE(MAX(sort_order) + 1, 0) AS n FROM categories WHERE group_id = $1 AND budget_id = $2 AND deleted = false',
        [groupId, budgetId],
      )
    ).rows[0].n,
  );
  const byId = new Map(found.rows.map((r) => [r.id, r.group_id]));
  for (const id of categoryIds) {
    const moving = byId.get(id) !== groupId;
    await client.query(
      `UPDATE categories SET bundle_id = $1, group_id = $2${moving ? ', sort_order = $5' : ''} WHERE id = $3 AND budget_id = $4`,
      moving ? [bundleId, groupId, id, budgetId, next++] : [bundleId, groupId, id, budgetId],
    );
  }
}

async function inTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const operations = [
  implement(bundlesList, async (_c, { budget_id }) => {
    const result = await pool.query('SELECT * FROM category_bundles WHERE budget_id = $1 ORDER BY created_at, id', [budget_id]);
    return result.rows;
  }),

  implement(bundlesCreate, async (_c, { budget_id, group_id, name, category_ids }) => {
    const ids = [...new Set(category_ids)];
    if (ids.length < 2) throw new HttpError(400, 'a bundle needs at least 2 distinct categories');
    return inTransaction(async (client) => {
      const group = await client.query(
        'SELECT 1 FROM category_groups WHERE id = $1 AND budget_id = $2 AND deleted = false',
        [group_id, budget_id],
      );
      if (group.rowCount === 0) throw new HttpError(404, 'category group not found in budget');
      const created = await client.query(
        'INSERT INTO category_bundles (budget_id, group_id, name) VALUES ($1, $2, $3) RETURNING *',
        [budget_id, group_id, name],
      );
      await assignCategories(client, budget_id, group_id, created.rows[0].id, ids);
      await normalizeBundles(client, budget_id);
      return created.rows[0];
    });
  }),

  implement(bundlesRename, async (_c, { id, budget_id, name }) => {
    const result = await pool.query('UPDATE category_bundles SET name = $1 WHERE id = $2 AND budget_id = $3', [name, id, budget_id]);
    if (result.rowCount === 0) throw new HttpError(404, 'bundle not found');
  }),

  implement(bundlesDelete, async (_c, { id, budget_id }) => {
    await inTransaction(async (client) => {
      await client.query('UPDATE categories SET bundle_id = NULL WHERE bundle_id = $1 AND budget_id = $2', [id, budget_id]);
      const result = await client.query('DELETE FROM category_bundles WHERE id = $1 AND budget_id = $2', [id, budget_id]);
      if (result.rowCount === 0) throw new HttpError(404, 'bundle not found');
    });
  }),

  implement(categoriesSetBundle, async (_c, { budget_id, category_ids, bundle_id }) => {
    const ids = [...new Set(category_ids)];
    await inTransaction(async (client) => {
      if (bundle_id === null) {
        const result = await client.query(
          'UPDATE categories SET bundle_id = NULL WHERE id = ANY($1::uuid[]) AND budget_id = $2 AND deleted = false',
          [ids, budget_id],
        );
        if (result.rowCount !== ids.length) throw new HttpError(404, 'category not found');
      } else {
        const bundle = await client.query<{ group_id: string }>(
          'SELECT group_id FROM category_bundles WHERE id = $1 AND budget_id = $2',
          [bundle_id, budget_id],
        );
        if (bundle.rowCount === 0) throw new HttpError(404, 'bundle not found');
        await assignCategories(client, budget_id, bundle.rows[0].group_id, bundle_id, ids);
      }
      await normalizeBundles(client, budget_id);
    });
  }),
];

export default budgetRouter('/bundles', operations);
