/**
 * HTTP handlers of the Categorize page. Only parse/authorise/shape: every SQL
 * statement lives in queue-store.ts / decision-store.ts / store.ts, and every
 * route is mounted behind budgetAccess by ./router.ts.
 */
import {
  categorizeAccept,
  categorizeQueueList,
  categorizeRunStart,
  categorizeRunStatus,
  categorizeSettingsGet,
  categorizeSettingsSet,
  categorizeSkip,
  categorizeTransferRefuse,
  categorizeTransferSuggestions,
  categorizeUndo,
} from '@shared/contracts/categorize';

import { implement } from '../core/operation';
import { pool } from '../core/db';
import { HttpError } from '../core/validate';
import { JEV_MAX_OPTIONS, jevUnavailableError } from '../jev';
import { requireUserId } from '../user';
import { acceptBundle, acceptCategories, refuseTransfer, skipTransaction, undoAccept } from './decision-store';
import { enqueueCategorizeRun } from './job';
import { decodeBundleKey, getConfidenceThreshold, listQueue, setConfidenceThreshold } from './queue-store';
import { runStatus } from './run-status';
import { offeredOptions } from './run-store';
import { transferSuggestions } from './transfer-store';

export const operations = [
  implement(categorizeQueueList, (_c, { budget_id: budgetId, limit, offset, bundle }) => {
    const key = bundle === undefined ? undefined : decodeBundleKey(bundle);
    if (key === null) throw new HttpError(400, 'invalid bundle key', 'invalid_input');
    return listQueue(pool, budgetId, { limit, offset, bundle: key });
  }),

  implement(categorizeTransferSuggestions, (_c, { budget_id: budgetId }) =>
    transferSuggestions(pool, budgetId).then((groups) => ({ groups })),
  ),

  implement(categorizeTransferRefuse, (c, { budget_id: budgetId, transaction_id, transfer_account_id }) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    return refuseTransfer(pool, budgetId, transaction_id, transfer_account_id, user.id);
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

  /**
   * Start a run, or answer the one in flight. A budget with no usable Jev key
   * never reaches the queue: the answer carries the same reason the page shows.
   * The category count is checked here too, so a run that cannot be answered
   * is refused before a job exists instead of failing after it starts.
   *
   * The size is the person's count trimmed by the hour's allowance, and it is
   * fixed here: the run never re-reads the clock, so `done` cannot pass `total`.
   */
  implement(categorizeRunStart, async (c, { budget_id: budgetId, count }) => {
    const userId = requireUserId(c);
    const status = await runStatus(pool, budgetId);
    if (status.reason !== null) throw jevUnavailableError(status.reason);
    // The same options the run would send, and the same ceiling: categories plus
    // one transfer option per other open account. Refusing here (rather than
    // after the job starts) is what the run's own check can only report later.
    const { categories, ceiling } = await offeredOptions(pool, budgetId);
    if (categories.length === 0) {
      throw new HttpError(409, 'this budget has no category to suggest', 'categorize_no_categories');
    }
    if (ceiling > JEV_MAX_OPTIONS) {
      throw new HttpError(
        409,
        `this budget offers ${ceiling} options (categories and accounts), more than the ${JEV_MAX_OPTIONS} Jev accepts`,
        'categorize_too_many_categories',
        { max: JEV_MAX_OPTIONS },
      );
    }
    // Starting again while a run is in flight answers that same run, whatever
    // the hour says now: the run's size was fixed when it was first delivered.
    if (status.run?.state === 'queued' || status.run?.state === 'running') return status;
    const take = Math.min(status.candidates, count === 'all' ? Number.MAX_SAFE_INTEGER : count);
    if (take === 0) {
      // Nothing waiting is nothing to start; a queue with rows but no allowance
      // waits for the hour, so the answer names the wait instead of a no-op run.
      if (status.waiting === 0) return status;
      const minutes = status.hourly.frees_in_minutes ?? 1;
      throw new HttpError(
        429,
        `this budget already sent ${status.hourly.limit} transactions to Jev in the last hour; the allowance frees up in about ${minutes} minutes`,
        'categorize_hourly_limit',
        { limit: status.hourly.limit, minutes },
      );
    }
    await enqueueCategorizeRun(pool, budgetId, userId, take);
    return runStatus(pool, budgetId);
  }),

  implement(categorizeRunStatus, (_c, { budget_id: budgetId }) => runStatus(pool, budgetId)),
];
