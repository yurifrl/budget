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
import { liveCategoryInBudget } from '../store/categories';
import { deleteTarget, listTargets, upsertTarget } from '../store/category-targets';

export const operations = [
  /** List all targets for a budget. */
  implement(categoryTargetsList, async (_c, { budget_id }) => listTargets(pool, budget_id)),

  /** Upsert the target for one category. */
  implement(categoryTargetsSet, async (_c, { categoryId, budget_id, kind, amount_cents, snooze_month, config: rawConfig }) => {
    const config = parseValue(targetConfigSchemas[kind], rawConfig);

    if (!(await liveCategoryInBudget(pool, categoryId, budget_id))) throw new HttpError(404, 'category not found');

    return upsertTarget(pool, {
      budgetId: budget_id,
      categoryId,
      kind,
      amountCents: amount_cents,
      snoozeMonth: snooze_month ?? null,
      configJson: JSON.stringify(config),
    });
  }),

  /** Remove the target for one category. */
  implement(categoryTargetsDelete, async (_c, { categoryId, budget_id }) => {
    if (!(await deleteTarget(pool, categoryId, budget_id))) throw new HttpError(404, 'target not found');
  }),
];

export default budgetRouter('/category-targets', operations);
