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
import { goalColumns } from '../domain/category-goals';
import { isBudgetMember } from '../ownership';
import { budgetRouter } from '../router';
import * as categoriesStore from '../store/categories';

/** 400 unless `userId` (non-null) is a member of the budget. */
async function assertMemberOrShared(budgetId: string, userId: string | null | undefined): Promise<void> {
  if (userId == null) return;
  if (!(await isBudgetMember(budgetId, userId))) {
    throw new HttpError(400, 'user_id is not a member of this budget', 'member_not_in_budget');
  }
}

export const operations = [
  implement(categoriesList, async (_c, { budget_id }) => categoriesStore.listLiveCategories(pool, budget_id)),

  implement(categoriesCreate, async (_c, { budget_id, group_id, name, sort_order, user_id }) => {
    // The group must belong to this budget; otherwise the insert would silently
    // create a cross-budget category.
    if (!(await categoriesStore.groupInBudget(pool, group_id, budget_id))) {
      throw new HttpError(404, 'category group not found in budget');
    }
    await assertMemberOrShared(budget_id, user_id);
    return categoriesStore.insertCategory(pool, {
      budgetId: budget_id,
      groupId: group_id,
      name,
      sortOrder: sort_order,
      userId: user_id ?? null,
    });
  }),

  implement(categoriesSetPerson, async (_c, { id, budget_id, user_id }) => {
    await assertMemberOrShared(budget_id, user_id);
    if (!(await categoriesStore.setCategoryPerson(pool, id, budget_id, user_id))) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesSetGroupPerson, async (_c, { budget_id, group_id, user_id }) => {
    await assertMemberOrShared(budget_id, user_id);
    if (!(await categoriesStore.groupInBudget(pool, group_id, budget_id))) {
      throw new HttpError(404, 'category group not found in budget');
    }
    await categoriesStore.setGroupCategoriesPerson(pool, group_id, budget_id, user_id);
  }),

  implement(categoriesSetNotes, async (_c, { id, budget_id, notes }) => {
    if (!(await categoriesStore.setCategoryNote(pool, id, budget_id, notes ?? null))) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesRename, async (_c, { id, budget_id, name }) => {
    if (!(await categoriesStore.renameCategory(pool, id, budget_id, name))) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesSetTarget, async (_c, { id, budget_id, target }) => {
    if (!(await categoriesStore.setCategoryGoal(pool, id, budget_id, goalColumns(target)))) {
      throw new HttpError(404, 'category not found');
    }
  }),

  // Bulk-reorder categories (plan-grid drag): one UPDATE per move in a single
  // transaction; every id must belong to this budget or nothing is written.
  implement(categoriesReorder, async (_c, { budget_id, moves }) => {
    return withTransaction(pool, async (client) => {
      let updated = 0;
      for (const move of moves) {
        // The target group must belong to this budget, like on create.
        if (!(await categoriesStore.groupInBudget(client, move.group_id, budget_id))) {
          throw new HttpError(404, 'category group not found in budget');
        }
        updated += await categoriesStore.moveCategory(client, budget_id, move);
      }
      if (updated !== moves.length) throw new HttpError(404, 'category not found');
      // A category moved to another group leaves its bundle (bundles stay within one group).
      await normalizeBundles(client, budget_id);
    });
  }),

  implement(categoriesSetHidden, async (_c, { id, budget_id, hidden }) => {
    if (!(await categoriesStore.setCategoryHidden(pool, id, budget_id, hidden))) throw new HttpError(404, 'category not found');
  }),

  implement(categoriesDelete, async (_c, { id, budget_id }) => {
    if (!(await categoriesStore.softDeleteCategory(pool, id, budget_id))) throw new HttpError(404, 'category not found');
    await normalizeBundles(pool, budget_id);
  }),
];

export default budgetRouter('/categories', operations);
