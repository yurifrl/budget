import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { payeeSuggestionGet } from '@shared/contracts/budget';
import { suggestedCategoryForPayee } from '../domain/categorization';
import { budgetRouter } from '../router';

export const operations = [
  /** GET /:id?budget_id=… — what the payee's next transaction would be categorized as. */
  implement(payeeSuggestionGet, async (_c, { id, budget_id }) => {
    const payee = await pool.query<{ categorization_mode: 'auto' | 'fixed' | 'never' }>(
      'SELECT categorization_mode FROM payees WHERE id = $1 AND budget_id = $2 AND deleted = false',
      [id, budget_id],
    );
    if (payee.rowCount === 0) throw new HttpError(404, 'payee not found');
    const client = await pool.connect();
    try {
      const category_id = await suggestedCategoryForPayee(client, budget_id, id);
      return { payee_id: id, categorization_mode: payee.rows[0].categorization_mode, category_id };
    } finally {
      client.release();
    }
  }),
];

export default budgetRouter('/payee-suggestions', operations);
