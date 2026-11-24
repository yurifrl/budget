/**
 * The Categorize page's routes, mounted at /categorize behind budgetAccess
 * (owner or member; anyone else gets 404, never 403) — the same guard every
 * budget-data route carries.
 */
import { budgetRouter } from '../budget';

import { operations } from './routes';

export default budgetRouter('/categorize', operations);
