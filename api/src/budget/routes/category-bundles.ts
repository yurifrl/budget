import type { PoolClient } from 'pg';

import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { bundlesCreate, bundlesDelete, bundlesList, bundlesRename, categoriesSetBundle } from '@shared/contracts/budget';
import { normalizeBundles } from '../domain/bundles';
import { budgetRouter } from '../router';
import * as bundlesStore from '../store/bundles';

/** Move categories into `groupId` (appended) and set their bundle, in the caller's transaction. */
async function assignCategories(
  client: PoolClient,
  budgetId: string,
  groupId: string,
  bundleId: string,
  categoryIds: string[],
): Promise<void> {
  const found = await bundlesStore.findLiveCategories(client, categoryIds, budgetId);
  if (found.length !== categoryIds.length) throw new HttpError(404, 'category not found');
  let next = await bundlesStore.nextSortOrderInGroup(client, groupId, budgetId);
  const byId = new Map(found.map((r) => [r.id, r.group_id]));
  for (const id of categoryIds) {
    const moving = byId.get(id) !== groupId;
    await bundlesStore.setCategoryBundle(client, { bundleId, groupId, id, budgetId, ...(moving ? { sortOrder: next++ } : {}) });
  }
}

export const operations = [
  implement(bundlesList, async (_c, { budget_id }) => bundlesStore.listBundles(pool, budget_id)),

  implement(bundlesCreate, async (_c, { budget_id, group_id, name, category_ids }) => {
    const ids = [...new Set(category_ids)];
    if (ids.length < 2) throw new HttpError(400, 'a bundle needs at least 2 distinct categories', 'bundle_needs_two_categories');
    return withTransaction(pool, async (client) => {
      if (!(await bundlesStore.liveGroupInBudget(client, group_id, budget_id))) {
        throw new HttpError(404, 'category group not found in budget');
      }
      const created = await bundlesStore.insertBundle(client, budget_id, group_id, name);
      await assignCategories(client, budget_id, group_id, created.id, ids);
      await normalizeBundles(client, budget_id);
      return created;
    });
  }),

  implement(bundlesRename, async (_c, { id, budget_id, name }) => {
    if (!(await bundlesStore.renameBundle(pool, id, budget_id, name))) throw new HttpError(404, 'bundle not found');
  }),

  implement(bundlesDelete, async (_c, { id, budget_id }) => {
    await withTransaction(pool, async (client) => {
      await bundlesStore.clearBundleFromCategories(client, id, budget_id);
      if (!(await bundlesStore.deleteBundle(client, id, budget_id))) throw new HttpError(404, 'bundle not found');
    });
  }),

  implement(categoriesSetBundle, async (_c, { budget_id, category_ids, bundle_id }) => {
    const ids = [...new Set(category_ids)];
    await withTransaction(pool, async (client) => {
      if (bundle_id === null) {
        const updated = await bundlesStore.unbundleCategories(client, ids, budget_id);
        if (updated !== ids.length) throw new HttpError(404, 'category not found');
      } else {
        const groupId = await bundlesStore.getBundleGroup(client, bundle_id, budget_id);
        if (groupId === undefined) throw new HttpError(404, 'bundle not found');
        await assignCategories(client, budget_id, groupId, bundle_id, ids);
      }
      await normalizeBundles(client, budget_id);
    });
  }),
];

export default budgetRouter('/bundles', operations);
