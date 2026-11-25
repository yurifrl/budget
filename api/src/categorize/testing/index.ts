/**
 * Categorizer test support (fake provider + database fixtures). Kept under
 * ./testing so production modules cannot import it by accident; eslint's
 * no-restricted-imports rule allows the path from *.test.ts only.
 */
export { answer, fakeProviders, toolTurn, type FakeCall, type FakeHandler, type FakeProviders } from './fake-provider';
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
