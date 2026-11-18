import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { normalizeBundles } from '../domain/bundles';
import { groupsCreate, groupsDelete, groupsList, groupsRename } from '@shared/contracts/budget';
import { budgetRouter } from '../router';
import { insertGroupLast, listGroups, renameGroup, tombstoneGroup, tombstoneGroupCategories } from '../store/groups';

export const operations = [
  implement(groupsList, async (_c, { budget_id }) => listGroups(pool, budget_id)),

  implement(groupsCreate, async (_c, { budget_id, name }) => {
    // Sort after the last existing group; the client never needs to compute it.
    return insertGroupLast(pool, budget_id, name);
  }),

  implement(groupsRename, async (_c, { id, budget_id, name }) => {
    if (!(await renameGroup(pool, id, budget_id, name))) throw new HttpError(404, 'category group not found');
  }),

  implement(groupsDelete, async (_c, { id, budget_id }) => {
    if (!(await tombstoneGroup(pool, id, budget_id))) throw new HttpError(404, 'category group not found');
    // YNAB semantics: deleting a group removes the whole group — tombstone its
    // live categories too (soft deletes keep assignment/transaction history).
    await tombstoneGroupCategories(pool, id, budget_id);
    await normalizeBundles(pool, budget_id);
  }),
];

export default budgetRouter('/groups', operations);
