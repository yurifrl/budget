/**
 * Category target routes — get/put/delete per category (bead syscd-app-nc5).
 *
 * One target per category (unique category_id). PUT upserts, DELETE removes.
 * The wire carries milliunits like every other amount; the table stores
 * cents (`amount_cents`), so this handler converts at the store boundary
 * (the contract only accepts whole cents, so nothing is rounded).
 */

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError, parseValue } from '../../core/validate';
import { categoryTargetsDelete, categoryTargetsList, categoryTargetsSet } from '@shared/contracts/budget';
import { targetConfigSchemas } from '@shared/contracts/budget/schemas';
import { budgetRouter } from '../router';
import { liveCategoryInBudget } from '../store/categories';
import { deleteTarget, listTargets, upsertTarget } from '../store/category-targets';

/** Stored row (amount_cents) -> wire shape (amount in milliunits). */
function targetJson(row: Record<string, unknown>) {
  const { amount_cents, ...rest } = row;
  return { ...rest, amount: Number(amount_cents) * 10 };
}

export const operations = [
  /** List all targets for a budget. */
  implement(categoryTargetsList, async (_c, { budget_id }) => (await listTargets(pool, budget_id)).map(targetJson)),

  /** Upsert the target for one category. */
  implement(categoryTargetsSet, async (_c, { categoryId, budget_id, kind, amount, snooze_month, config: rawConfig }) => {
    const config = parseValue(targetConfigSchemas[kind], rawConfig);

    if (!(await liveCategoryInBudget(pool, categoryId, budget_id))) throw new HttpError(404, 'category not found');

    return targetJson(await upsertTarget(pool, {
      budgetId: budget_id,
      categoryId,
      kind,
      amountCents: amount / 10,
      snoozeMonth: snooze_month ?? null,
      configJson: JSON.stringify(config),
    }));
  }),

  /** Remove the target for one category. */
  implement(categoryTargetsDelete, async (_c, { categoryId, budget_id }) => {
    if (!(await deleteTarget(pool, categoryId, budget_id))) throw new HttpError(404, 'target not found');
  }),
];

export default budgetRouter('/category-targets', operations);
