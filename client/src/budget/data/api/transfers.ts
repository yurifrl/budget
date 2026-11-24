/**
 * budgetApi slice: transfers between own accounts (budget-mit6): the review
 * list of suggestions, link / unlink (Undo), "not a transfer" decisions and
 * the payee "treat as transfer" rule. Injected into the one `budgetApi`
 * (see ../api.ts). Every write refreshes the register (rows carry the
 * suggestion summary) and the payees list (it carries the rule).
 */
import { contractRequest } from '@shared/contract-request';
import {
  payeesSetTransferRule,
  payeesTransferRuleGet,
  transferSuggestionsList,
  transfersLink,
  transfersMark,
  transfersUnlink,
} from '@shared/contracts/budget';
import type { OperationOutput } from '@shared/operation-contract';
import type { z } from '@shared/zod';
import { type BudgetScope } from './base';
import { connectionsApi } from './connections';

export type TransferSuggestion = OperationOutput<typeof transferSuggestionsList>[number];
export type TransferLinkResult = OperationOutput<typeof transfersLink>;
export type PayeeTransferRule = OperationOutput<typeof payeesTransferRuleGet>;
export type TransferLinkInput = z.input<typeof transfersLink.input>['links'][number];
export type TransferRuleInput = Omit<z.input<typeof payeesSetTransferRule.input>, 'id' | 'budget_id'>;

export const transfersApi = connectionsApi.injectEndpoints({
  endpoints: (b) => ({
    getTransferSuggestions: b.query<TransferSuggestion[], BudgetScope & { accountId?: string | null }>({
      query: ({ budgetId, accountId }) =>
        contractRequest(transferSuggestionsList, { budget_id: budgetId, ...(accountId ? { account_id: accountId } : {}) }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Transactions', id: budgetId }],
    }),

    linkTransfers: b.mutation<TransferLinkResult, BudgetScope & { links: TransferLinkInput[]; rememberPayee?: boolean }>({
      query: ({ budgetId, links, rememberPayee }) =>
        contractRequest(transfersLink, { budget_id: budgetId, links, remember_payee: rememberPayee ?? false }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    unlinkTransfers: b.mutation<{ unlinked: number }, BudgetScope & { transactionIds: string[] }>({
      query: ({ budgetId, transactionIds }) => contractRequest(transfersUnlink, { budget_id: budgetId, transaction_ids: transactionIds }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    markTransfers: b.mutation<{ updated: number }, BudgetScope & { transactionIds: string[]; state: 'dismissed' | 'outside' | null }>({
      query: ({ budgetId, transactionIds, state }) =>
        contractRequest(transfersMark, { budget_id: budgetId, transaction_ids: transactionIds, state }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    getPayeeTransferRule: b.query<PayeeTransferRule, BudgetScope & { payeeId: string }>({
      query: ({ budgetId, payeeId }) => contractRequest(payeesTransferRuleGet, { id: payeeId, budget_id: budgetId }),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Payees', id: budgetId }],
    }),

    setPayeeTransferRule: b.mutation<PayeeTransferRule, BudgetScope & { payeeId: string; rule: TransferRuleInput }>({
      query: ({ budgetId, payeeId, rule }) => contractRequest(payeesSetTransferRule, { id: payeeId, budget_id: budgetId, ...rule }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),
  }),
});
