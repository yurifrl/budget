import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { assignmentsBatch, assignmentsList, assignmentsSet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

export const operations = [
  implement(assignmentsList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT month, category_id, budgeted FROM assignments WHERE budget_id = $1',
      [budget_id],
    );
    return result.rows;
  }),

  implement(assignmentsSet, async (_c, { budget_id, month, category_id, budgeted }) => {
    const result = await pool.query(
      `INSERT INTO assignments (budget_id, month, category_id, budgeted)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (budget_id, month, category_id)
       DO UPDATE SET budgeted = EXCLUDED.budgeted
       RETURNING month, category_id, budgeted`,
      [budget_id, month, category_id, budgeted],
    );
    return result.rows[0];
  }),

  implement(assignmentsBatch, async (_c, { budget_id, month, updates }) => {
    return withTransaction(pool, async (client) => {
      for (const u of updates) {
        await client.query(
          `INSERT INTO assignments (budget_id, month, category_id, budgeted)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (budget_id, month, category_id)
           DO UPDATE SET budgeted = EXCLUDED.budgeted`,
          [budget_id, month, u.category_id, u.budgeted],
        );
      }
    });
  }),
];

export default budgetRouter('/assignments', operations);
