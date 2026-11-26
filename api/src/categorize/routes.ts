/**
 * HTTP handlers of the Categorize page. Only parse/authorise/shape: every SQL
 * statement lives in queue-store.ts / decision-store.ts / store.ts, and every
 * route is mounted behind budgetAccess by ./router.ts.
 */
import {
  categorizeAccept,
  categorizeQueueList,
  categorizeSettingsGet,
  categorizeSettingsSet,
  categorizeSkip,
  categorizeUndo,
} from '@shared/contracts/categorize';

import { implement } from '../core/operation';
import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import { acceptBundle, acceptCategories, skipTransaction, undoAccept } from './decision-store';
import { decodeBundleKey, getConfidenceThreshold, listQueue, setConfidenceThreshold } from './queue-store';

export const operations = [
  implement(categorizeQueueList, (_c, { budget_id: budgetId, limit, offset, bundle }) => {
    const key = bundle === undefined ? undefined : decodeBundleKey(bundle);
    if (key === null) throw new HttpError(400, 'invalid bundle key', 'invalid_input');
    return listQueue(pool, budgetId, { limit, offset, bundle: key });
  }),

  implement(categorizeAccept, (c, { budget_id: budgetId, items, bundle_key: bundleKey, expected_count: expectedCount }) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    if ((items === undefined) === (bundleKey === undefined)) {
      throw new HttpError(400, 'send exactly one of items or bundle_key', 'invalid_input');
    }
    if (bundleKey !== undefined) {
      if (expectedCount === undefined) {
        throw new HttpError(400, 'expected_count is required with bundle_key', 'invalid_input');
      }
      const key = decodeBundleKey(bundleKey);
      if (!key) throw new HttpError(400, 'invalid bundle key', 'invalid_input');
      return acceptBundle(pool, budgetId, key, expectedCount, user.id);
    }
    if (expectedCount !== undefined) {
      throw new HttpError(400, 'expected_count is only valid with bundle_key', 'invalid_input');
    }
    if (items === undefined) throw new HttpError(400, 'items are required', 'invalid_input');
    return acceptCategories(pool, budgetId, items, user.id);
  }),

  implement(categorizeUndo, (_c, { budget_id: budgetId, transaction_ids }) =>
    undoAccept(pool, budgetId, transaction_ids),
  ),

  implement(categorizeSkip, (c, { budget_id: budgetId, transaction_id }) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    return skipTransaction(pool, budgetId, transaction_id, user.id);
  }),

  implement(categorizeSettingsGet, async (_c, { budget_id: budgetId }) => ({
    budget_id: budgetId,
    confidence_threshold: await getConfidenceThreshold(pool, budgetId),
  })),

  implement(categorizeSettingsSet, async (_c, { budget_id: budgetId, confidence_threshold }) => ({
    budget_id: budgetId,
    confidence_threshold: await setConfidenceThreshold(pool, budgetId, confidence_threshold),
  })),
];
