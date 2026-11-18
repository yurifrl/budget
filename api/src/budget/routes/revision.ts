import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { budgetRevisionGet } from '@shared/contracts/budget';
import { budgetRouter } from '../router';

export const operations = [
  /** GET ?budget_id=… — the budget's change revision (bumped by DB triggers, see migration 0033). */
  implement(budgetRevisionGet, async (_c, { budget_id }) => {
    const r = await pool.query<{ revision: string }>('SELECT revision FROM public.budgets WHERE id = $1', [budget_id]);
    if (r.rowCount === 0) throw new HttpError(404, 'budget not found');
    // bigint arrives as a string; counters stay far below 2^53.
    return { revision: Number(r.rows[0].revision) };
  }),
];

export default budgetRouter('/budget-revision', operations);
