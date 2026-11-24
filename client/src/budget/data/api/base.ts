/**
 * budgetApi — RTK Query api for the Budget app over the Hono API. This file
 * creates the one api (reducer path, base query, tags, refetch policy); the
 * endpoints are injected per area (`./budgets`, `./members`, `./plan`,
 * `./payees`, `./register`, `./connections`) and the fully injected api is
 * exported as `budgetApi` from `../api.ts`, the only import path the app uses.
 *
 * Storage is the YNAB-v1-compatible schema (migration 0004): milliunits,
 * signed transaction amounts, payee_id references, the goal model, and
 * first-of-month date months. The wire carries MILLIUNITS for every amount,
 * both directions. This layer is the BOUNDARY — endpoints accept app-facing
 * input (cents, inflow/outflow, payee names, MonthKey) and convert to wire
 * milliunits on write; reads return raw rows that `mapping.ts` converts back
 * to the engine domain (or, for the few cents-shaped app types, a
 * `transformResponse` converts here). Every request is built from its shared
 * contract with `contractRequest` (no hand-written URLs).
 *
 * Budget-awareness: every read passes `?budget_id=…`, every insert sends
 * `budget_id`, and every cache tag is keyed by the budget id — so invalidation
 * never crosses budgets.
 *
 * Derived values (RTA / available / funding state) are never written — only
 * raw rows; the engine recomputes after each invalidation.
 */
import { createApi } from '@reduxjs/toolkit/query/react';

import { contractRequest } from '@shared/contract-request';
import { apiBaseQuery, type ApiQuery } from '@/platform/api/baseQuery';

/** Argument carried by every budget-scoped endpoint (also the cache-tag key). */
export interface BudgetScope {
  budgetId: string;
}

/** Request builder for a budget-scoped list read: `{ budgetId }` -> `{ budget_id }`. */
export function scopedList(contract: Parameters<typeof contractRequest>[0]) {
  return ({ budgetId }: BudgetScope): ApiQuery => contractRequest(contract, { budget_id: budgetId });
}

export const baseApi = createApi({
  reducerPath: 'budgetApi',
  baseQuery: apiBaseQuery,
  // Writes from elsewhere (sync worker, webhooks, CLI/MCP, other devices) never
  // invalidate our tags: refetch active queries when the app regains focus or
  // connectivity (core/state/listeners wires focus/online for web AND native).
  refetchOnFocus: true,
  refetchOnReconnect: true,
  tagTypes: ['Budgets', 'Groups', 'Categories', 'Bundles', 'Accounts', 'Transactions', 'Assignments', 'MonthNotes', 'Payees', 'Targets', 'CategoryNotes', 'Connections', 'ConnectionCredentials', 'Members', 'AiCredentials'],
  endpoints: () => ({}),
});
