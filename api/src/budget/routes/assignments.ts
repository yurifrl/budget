import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { assignmentsBatch, assignmentsList, assignmentsSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';
import { listAssignments, upsertAssignment, upsertAssignmentReturning } from '../store/assignments';

export const operations = [
  implement(assignmentsList, async (_c, { budget_id }) => listAssignments(pool, budget_id)),

  implement(assignmentsSet, async (_c, { budget_id, month, category_id, budgeted }) =>
    upsertAssignmentReturning(pool, budget_id, month, category_id, budgeted),
  ),

  implement(assignmentsBatch, async (_c, { budget_id, month, updates }) => {
    return withTransaction(pool, async (client) => {
      for (const u of updates) {
        await upsertAssignment(client, budget_id, month, u.category_id, u.budgeted);
      }
    });
  }),
];

export default budgetRouter('/assignments', operations);
