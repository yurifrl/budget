import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  categoriesCreate,
  categoriesDelete,
  categoriesList,
  categoriesRename,
  categoriesReorder,
  categoriesSetHidden,
  categoriesSetGroupPerson,
  categoriesSetNotes,
  categoriesSetPerson,
  categoriesSetTarget,
} from '@shared/contracts/budget';
import { normalizeBundles } from '../domain/bundles';
import { isBudgetMember } from '../ownership';
import { budgetRouter } from '../router';

/** 400 unless `userId` (non-null) is a member of the budget. */
async function assertMemberOrShared(budgetId: string, userId: string | null | undefined): Promise<void> {
  if (userId == null) return;
  if (!(await isBudgetMember(budgetId, userId))) {
    throw new HttpError(400, 'user_id is not a member of this budget');
  }
}

export const operations = [
  implement(categoriesList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT * FROM categories WHERE budget_id = $1 AND deleted = false ORDER BY sort_order',
      [budget_id],
    );
    return result.rows;
  }),

  implement(categoriesCreate, async (_c, { budget_id, group_id, name, sort_order, user_id }) => {
    // The group must belong to this budget; otherwise the insert would silently
    // create a cross-budget category.
    const groupCheck = await pool.query('SELECT 1 FROM category_groups WHERE id = $1 AND budget_id = $2', [
      group_id,
      budget_id,
    ]);
    if (groupCheck.rowCount === 0) throw new HttpError(404, 'category group not found in budget');
    await assertMemberOrShared(budget_id, user_id);
    const result = await pool.query(
      'INSERT INTO categories (budget_id, group_id, name, sort_order, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [budget_id, group_id, name, sort_order, user_id ?? null],
    );
    return result.rows[0];
  }),

  implement(categoriesSetPerson, async (_c, { id, budget_id, user_id }) => {
    await assertMemberOrShared(budget_id, user_id);
    const result = await pool.query(
      'UPDATE categories SET user_id = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [user_id, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesSetGroupPerson, async (_c, { budget_id, group_id, user_id }) => {
    await assertMemberOrShared(budget_id, user_id);
    const group = await pool.query('SELECT 1 FROM category_groups WHERE id = $1 AND budget_id = $2', [group_id, budget_id]);
    if (group.rowCount === 0) throw new HttpError(404, 'category group not found in budget');
    await pool.query(
      'UPDATE categories SET user_id = $1 WHERE group_id = $2 AND budget_id = $3 AND deleted = false',
      [user_id, group_id, budget_id],
    );
  }),

  implement(categoriesSetNotes, async (_c, { id, budget_id, notes }) => {
    const result = await pool.query(
      'UPDATE categories SET note = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [notes ?? null, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesRename, async (_c, { id, budget_id, name }) => {
    const result = await pool.query(
      'UPDATE categories SET name = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [name, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesSetTarget, async (_c, { id, budget_id, target }) => {
    const cols = goalColumns(target);
    const result = await pool.query(
      `UPDATE categories SET
        goal_type = $1,
        goal_target = $2,
        goal_cadence = $3,
        goal_cadence_frequency = $4,
        goal_target_date = $5,
        goal_needs_whole_amount = $6
       WHERE id = $7 AND budget_id = $8 AND deleted = false`,
      [
        cols.goal_type,
        cols.goal_target,
        cols.goal_cadence,
        cols.goal_cadence_frequency,
        cols.goal_target_date,
        cols.goal_needs_whole_amount,
        id,
        budget_id,
      ],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
  }),

  // Bulk-reorder categories (plan-grid drag): one UPDATE per move in a single
  // transaction; every id must belong to this budget or nothing is written.
  implement(categoriesReorder, async (_c, { budget_id, moves }) => {
    return withTransaction(pool, async (client) => {
      let updated = 0;
      for (const move of moves) {
        const result = await client.query(
          'UPDATE categories SET group_id = $1, sort_order = $2 WHERE id = $3 AND budget_id = $4 AND deleted = false',
          [move.group_id, move.sort_order, move.id, budget_id],
        );
        updated += result.rowCount ?? 0;
      }
      if (updated !== moves.length) throw new HttpError(404, 'category not found');
      // A category moved to another group leaves its bundle (bundles stay within one group).
      await normalizeBundles(client, budget_id);
    });
  }),

  implement(categoriesSetHidden, async (_c, { id, budget_id, hidden }) => {
    const result = await pool.query(
      'UPDATE categories SET hidden = $1 WHERE id = $2 AND budget_id = $3 AND deleted = false',
      [hidden, id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesDelete, async (_c, { id, budget_id }) => {
    const result = await pool.query(
      'UPDATE categories SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id],
    );
    if (result.rowCount === 0) throw new HttpError(404, 'category not found');
    await normalizeBundles(pool, budget_id);
  }),
];

export interface TargetInput {
  amount_cents?: number;
  cadence?: 'weekly' | 'monthly' | 'yearly' | 'custom';
  by_date?: string;
  behavior?: 'set-aside' | 'refill';
}

export function goalColumns(target: TargetInput | null): {
  goal_type: string | null;
  goal_target: number | null;
  goal_cadence: number | null;
  goal_cadence_frequency: number | null;
  goal_target_date: string | null;
  goal_needs_whole_amount: boolean | null;
} {
  if (!target) {
    return {
      goal_type: null,
      goal_target: null,
      goal_cadence: null,
      goal_cadence_frequency: null,
      goal_target_date: null,
      goal_needs_whole_amount: null,
    };
  }
  const milli = (target.amount_cents ?? 0) * 10;
  if (target.cadence === 'custom') {
    return {
      goal_type: 'TBD',
      goal_target: milli,
      goal_target_date: target.by_date ?? null,
      goal_cadence: null,
      goal_cadence_frequency: null,
      goal_needs_whole_amount: null,
    };
  }
  const cadence = target.cadence === 'weekly' ? 2 : target.cadence === 'yearly' ? 13 : 1;
  return {
    goal_type: 'NEED',
    goal_target: milli,
    goal_cadence: cadence,
    goal_cadence_frequency: 1,
    goal_target_date: target.cadence === 'yearly' ? (target.by_date ?? null) : null,
    goal_needs_whole_amount: target.cadence === 'monthly' ? target.behavior !== 'refill' : null,
  };
}

export default budgetRouter('/categories', operations);
