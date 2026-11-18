import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { assignmentsBatch, assignmentsList, assignmentsSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';
import { HttpError } from '../../core/validate';
import { categoryInBudget } from '../store/categories';
import { listAssignments, upsertAssignment, upsertAssignmentReturning } from '../store/assignments';

export const operations = [
  implement(assignmentsList, async (_c, { budget_id }) => listAssignments(pool, budget_id)),

  implement(assignmentsSet, async (_c, { budget_id, month, category_id, budgeted }) => {
    // The category must belong to this budget, like plan-auto-assign.
    if (!(await categoryInBudget(pool, category_id, budget_id))) throw new HttpError(400, 'category not found in budget');
    return upsertAssignmentReturning(pool, budget_id, month, category_id, budgeted);
  }),

  implement(assignmentsBatch, async (_c, { budget_id, month, updates }) => {
    return withTransaction(pool, async (client) => {
      for (const u of updates) {
        if (!(await categoryInBudget(client, u.category_id, budget_id))) throw new HttpError(400, 'category not found in budget');
        await upsertAssignment(client, budget_id, month, u.category_id, u.budgeted);
      }
    });
  }),
];

export default budgetRouter('/assignments', operations);
