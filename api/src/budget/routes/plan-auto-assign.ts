import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { planAutoAssign } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

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
        const catCheck = await client.query(
          'SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2 AND deleted = false',
          [row.category_id, budget_id],
        );
        if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget');
        // Same milliunits storage as /assignments/batch (cents * 10).
        await client.query(
          `INSERT INTO assignments (budget_id, month, category_id, budgeted)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (budget_id, month, category_id)
           DO UPDATE SET budgeted = EXCLUDED.budgeted`,
          [budget_id, month, row.category_id, row.assign_cents * 10],
        );
      }
    });
  }),
];

export default budgetRouter('/plan-auto-assign', operations);
