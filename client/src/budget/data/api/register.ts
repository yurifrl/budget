/**
 * budgetApi slice: Register: accounts, transactions, repeat rules, statement import.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import type { z } from '@shared/zod';
import { contractRequest } from '@shared/contract-request';
import { accountsCreate, accountsDelete, accountsList, accountsReconcile, accountsUpdate, repeatRulesCreate, repeatRulesDelete, transactionsBulk, transactionsCreate, transactionsDelete, transactionsList, transactionsUpdate } from '@shared/contracts/budget';
import type { Cents, RepeatFrequency } from '../../domain/types';
import { centsToMilli, type ImportTxnWire, snakeSubTxn, snakeTxn, snakeTxnPatch, type SubTxnInput, type TransactionInput } from '../mapping';
import type { AccountRow, AccountTypeRow, RepeatRuleRow, TransactionRow } from '../rows';
import { type BudgetScope, scopedList } from './base';
import type { SubWire } from './types';
import { payeesApi } from './payees';

export const registerApi = payeesApi.injectEndpoints({
  endpoints: (b) => ({
    getAccounts: b.query<AccountRow[], BudgetScope>({
      query: scopedList(accountsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Accounts', id: budgetId }],
    }),

    getTransactions: b.query<TransactionRow[], BudgetScope>({
      query: scopedList(transactionsList),
      providesTags: (_r, _e, { budgetId }) => [{ type: 'Transactions', id: budgetId }],
    }),

    /** Insert a transaction (resolving its payee to a payee_id); the server derives the account balance deltas. */
    addTransaction: b.mutation<
      TransactionRow,
      BudgetScope & { txn: TransactionInput; subtransactions?: SubTxnInput[] }
    >({
      query: ({ budgetId, txn, subtransactions }) =>
        contractRequest(transactionsCreate, {
          budget_id: budgetId,
          txn: snakeTxn(txn) as z.input<typeof transactionsCreate.input>['txn'],
          subtransactions: subtransactions?.map(snakeSubTxn) as SubWire,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Patch a transaction (edit / approve / categorize); the server re-derives account balances. */
    updateTransaction: b.mutation<
      null,
      BudgetScope & {
        id: string;
        patch: Partial<TransactionInput>;
        subtransactions?: SubTxnInput[];
      }
    >({
      query: ({ budgetId, id, patch, subtransactions }) =>
        contractRequest(transactionsUpdate, {
          id,
          budget_id: budgetId,
          patch: snakeTxnPatch(patch) as z.input<typeof transactionsUpdate.input>['patch'],
          subtransactions: subtransactions?.map(snakeSubTxn) as SubWire,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Soft-delete a transaction; the server reverses its balance effect (syscd-app-42f row menu). */
    deleteTransaction: b.mutation<null, BudgetScope & { id: string }>({
      query: ({ budgetId, id }) => contractRequest(transactionsDelete, { id, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /** Create a repeat rule; optionally attach the triggering draft txn and materialize due occurrences now. */
    addRepeatRule: b.mutation<
      RepeatRuleRow,
      BudgetScope & {
        accountId: string;
        payee: string;
        categoryId: string | null;
        memo: string | null;
        outflowCents: Cents;
        inflowCents: Cents;
        frequency: RepeatFrequency;
        monthLastDay: boolean;
        attachTransactionId: string | null;
      }
    >({
      query: ({ budgetId, accountId, payee, categoryId, memo, outflowCents, inflowCents, frequency, monthLastDay, attachTransactionId }) =>
        contractRequest(repeatRulesCreate, {
          budget_id: budgetId,
          account_id: accountId,
          payee,
          category_id: categoryId,
          memo,
          outflow: centsToMilli(outflowCents),
          inflow: centsToMilli(inflowCents),
          frequency,
          month_last_day: monthLastDay,
          attach_transaction_id: attachTransactionId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /** Delete a repeat rule: stops generation and soft-deletes pending upcoming instances. */
    deleteRepeatRule: b.mutation<null, BudgetScope & { ruleId: string }>({
      query: ({ budgetId, ruleId }) => contractRequest(repeatRulesDelete, { id: ruleId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /**
     * Create an account (name + YNAB type). A non-zero opening balance is
     * booked server-side as a "Starting Balance" transaction carrying the
     * amount (debt types start negative, at the amount owed).
     */
    addAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        name: string;
        type: AccountTypeRow;
        onBudget?: boolean;
        balanceCents: Cents;
        /** Person (budget member) owning the account; omit/null = Shared. */
        userId?: string | null;
      }
    >({
      query: ({ budgetId, name, type, onBudget, balanceCents, userId }) =>
        contractRequest(accountsCreate, {
          budget_id: budgetId,
          name,
          type,
          on_budget: onBudget ?? true,
          balance: centsToMilli(balanceCents),
          ...(userId ? { user_id: userId } : {}),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /**
     * Edit account fields. `workingBalanceCents` SETS the balance directly —
     * an override, not a ledger operation (no adjustment entry is booked);
     * `closed` toggles the CLOSED group per the 0004 sync invariant.
     */
    updateAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        accountId: string;
        name?: string;
        note?: string | null;
        closed?: boolean;
        workingBalanceCents?: Cents;
        /** Person owning the account; null = Shared, omit = unchanged. */
        userId?: string | null;
      }
    >({
      query: ({ budgetId, accountId, name, note, closed, workingBalanceCents, userId }) =>
        contractRequest(accountsUpdate, {
          id: accountId,
          budget_id: budgetId,
          name,
          note,
          closed,
          working_balance: workingBalanceCents === undefined ? undefined : centsToMilli(workingBalanceCents),
          user_id: userId,
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Transactions', id: budgetId },
      ],
    }),

    /**
     * Delete a closed account with every transaction it ever held. The
     * server moves balances itself (reverse of each deleted row) — no client
     * delta contract like deleteTransaction.
     */
    deleteAccount: b.mutation<null, BudgetScope & { accountId: string }>({
      query: ({ budgetId, accountId }) => contractRequest(accountsDelete, { id: accountId, budget_id: budgetId }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        { type: 'Transactions', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),

    /**
     * Reconcile: set the account's working balance to the stated value
     * (booking an adjustment transaction for any difference, uncategorized so
     * it lands in Ready-to-Assign) and lock every transaction as reconciled.
     * `reconcileAll` is YNAB's "Yes" shortcut: the on-screen balance already
     * matches the bank, so every row — pending included — locks as reconciled
     * with no adjustment booked.
     */
    reconcileAccount: b.mutation<
      null,
      BudgetScope & { accountId: string; statedBalanceCents: Cents; reconcileAll?: boolean }
    >({
      query: ({ budgetId, accountId, statedBalanceCents, reconcileAll }) =>
        contractRequest(accountsReconcile, {
          id: accountId,
          budget_id: budgetId,
          stated_balance: centsToMilli(statedBalanceCents),
          ...(reconcileAll ? { reconcile_all: true } : {}),
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /**
     * Statement import: one batch of parsed rows into one account. The server
     * resolves payees (rename rules + upsert), dedupes on import_id, computes
     * the account balance delta itself, and stores rows uncleared/unapproved.
     */
    importTransactions: b.mutation<
      { imported: number; duplicates: number },
      BudgetScope & { accountId: string; txns: ImportTxnWire[] }
    >({
      query: ({ budgetId, accountId, txns }) =>
        contractRequest(transactionsBulk, { budget_id: budgetId, account_id: accountId, txns }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Transactions', id: budgetId },
        { type: 'Accounts', id: budgetId },
        { type: 'Payees', id: budgetId },
      ],
    }),
  }),
});
