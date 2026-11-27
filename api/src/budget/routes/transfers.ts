/**
 * Transfers between own accounts (budget-mit6): suggestions, person-made
 * links, unlink (Undo) and "not a transfer" decisions.
 * Rules live in domain/transfer-matcher.ts, SQL in store/transfers.ts.
 */
import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { transferSuggestionsList, transfersLink, transfersMark, transfersUnlink } from '@shared/contracts/budget';
import { linkByUser, listTransferSuggestions, markTransfers, unlinkTransfers } from '../domain/transfer-links';
import { budgetRouter } from '../router';
import { findAccountInBudget } from '../store/accounts';

export const operations = [
  implement(transferSuggestionsList, async (_c, { budget_id, account_id }) => {
    if (account_id && !(await findAccountInBudget(pool, account_id, budget_id))) throw new HttpError(404, 'account not found');
    return listTransferSuggestions(pool, budget_id, account_id);
  }),

  implement(transfersLink, (_c, { budget_id, links, remember_payee }) =>
    withTransaction(pool, (client) => linkByUser(client, budget_id, links, remember_payee ?? false)),
  ),

  implement(transfersUnlink, async (_c, { budget_id, transaction_ids }) => ({
    unlinked: await withTransaction(pool, (client) => unlinkTransfers(client, budget_id, transaction_ids)),
  })),

  implement(transfersMark, async (_c, { budget_id, transaction_ids, state }) => ({
    updated: await withTransaction(pool, (client) => markTransfers(client, budget_id, transaction_ids, state)),
  })),
];

export default budgetRouter('/transfers', operations);
