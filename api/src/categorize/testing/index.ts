/**
 * Categorizer test support (database fixtures). Kept under
 * ./testing so production modules cannot import it by accident; eslint's
 * no-restricted-imports rule allows the path from *.test.ts only.
 */
export {
  cleanupFixtures,
  newAccount,
  newBudget,
  newCategory,
  newGroup,
  newPayee,
  newTransaction,
  newUser,
  suggestionsOf,
  type BudgetFixture,
  type TransactionFixture,
} from './fixtures';
