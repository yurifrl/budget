import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { planAutoAssign } from '@shared/contracts/budget';
import { budgetRouter } from '../router';
import { upsertAssignment } from '../store/assignments';
import { liveCategoryInBudget } from '../store/categories';

export const operations = [
  /**
   * Auto-assign (bead syscd-app-glm) — apply one panel strategy's computed
   * assignments. The client previews strategies locally from its own budget
   * model; this route is the trust boundary that persists the resulting
   * absolute assigned amounts for a month, exactly as posted.
   */
  implement(planAutoAssign, async (_c, { budget_id, month, rows }) => {
    return withTransaction(pool, async (client) => {
      for (const row of rows) {
        if (!(await liveCategoryInBudget(client, row.category_id, budget_id))) {
          throw new HttpError(400, 'category not found in budget');
        }
        // Milliunits in, milliunits stored (same as /assignments/batch).
        await upsertAssignment(client, budget_id, month, row.category_id, row.assigned);
      }
    });
  }),
];

export default budgetRouter('/plan-auto-assign', operations);
