import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { payeeSuggestionGet } from '@shared/contracts/budget';
import { suggestedCategoryForPayee } from '../domain/categorization';
import { budgetRouter } from '../router';
import { getPayeeCategorizationMode } from '../store/payees';

export const operations = [
  /** GET /:id?budget_id=… — what the payee's next transaction would be categorized as. */
  implement(payeeSuggestionGet, async (_c, { id, budget_id }) => {
    const mode = await getPayeeCategorizationMode(pool, id, budget_id);
    if (mode === undefined) throw new HttpError(404, 'payee not found');
    const category_id = await suggestedCategoryForPayee(pool, budget_id, id);
    return { payee_id: id, categorization_mode: mode, category_id };
  }),
];

export default budgetRouter('/payee-suggestions', operations);
