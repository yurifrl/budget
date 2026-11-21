import { z } from '../../zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '../../operation-contract';
import { connectionId, syncWindowDaysSchema, uuidSchema } from './schemas';
import { connectTokenSchema, connectionDeletedSchema, connectionRegisteredSchema, connectionSchema, connectionSettingsSchema, connectionSummarySchema, connectionTxnPageSchema, connectionUpstreamSchema, connectionsSyncResultSchema, syncStatusSchema } from './outputs';

const API_ONLY = { api: true, cli: false, mcp: false } as const;

export const connectionsList = defineOperation({
  name: 'connections_list',
  description:
    "List the current user's linked bank connections with provider, institution, status (a non-connected status means the user must re-authenticate in the app) and last sync time.",
  input: z.object({}),
  output: z.array(connectionSchema),
  method: 'GET',
  path: '/connections',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const connectionsSettingsGet = defineOperation({
  name: 'connections_settings_get',
  description: 'Get the bank-sync window: how many days back each pull reaches (0 = all history). App-wide setting.',
  input: z.object({}),
  output: connectionSettingsSchema,
  method: 'GET',
  path: '/connections/settings',
  kind: 'read',
  expose: EXPOSE_NO_MCP,
});

export const connectionsSettingsUpdate = defineOperation({
  name: 'connections_settings_update',
  description: 'Set the bank-sync window in days: 0 for all history, or 1 to 3650. App-wide setting, so admins only (403 otherwise; each user sets their own banks with connections_settings_update_one). Returns the stored value.',
  input: z.object({ syncWindowDays: syncWindowDaysSchema }),
  output: connectionSettingsSchema,
  method: 'PATCH',
  path: '/connections/settings',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const connectionsSettingsUpdateOne = defineOperation({
  name: 'connections_settings_update_one',
  description:
    "Set one bank connection's own sync window in days (0 = all history, 1 to 3650), or null to inherit the app-wide default. Returns the updated connection. 404 if not the current user's.",
  input: z.object({ id: connectionId, syncWindowDays: syncWindowDaysSchema.nullable() }),
  output: connectionSchema,
  method: 'PATCH',
  path: '/connections/:id/settings',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const connectionsUpstream = defineOperation({
  name: 'connections_upstream_list',
  description:
    "List every bank account upstream of the current user's live connections, each annotated (balance is signed integer MILLIUNITS, 12.34 = 12340, null if unreported; currencyCode is the provider's ISO 4217 code) with the budget account it is linked to (linkedAccountId, or null). CREDIT accounts also carry credit: { limit, available, used, minimumPayment, dueDate, latestBill: { total, dueDate, minimumPayment } | null } (milliunits; many issuers report balance 0 for cards, so use the bill and limit figures); credit is absent/null for BANK accounts. accounts is null for a connection whose provider call failed.",
  input: z.object({}),
  output: z.array(connectionUpstreamSchema),
  method: 'GET',
  path: '/connections/upstream',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const connectionsConnectToken = defineOperation({
  name: 'connections_connect_token',
  description:
    "Mint short-lived widget credentials for the provider's connect widget (in-app connect flow). connectorId preselects a bank; itemId re-authenticates an existing item instead of creating a duplicate. A new connection uses the caller's own key set when one is saved, else the installation's shared keys if the caller may use them, else 403 own_keys_required. A re-auth uses the key set the connection was created with.",
  input: z.object({
    provider: z.string().min(1),
    connectorId: z.number().int().optional(),
    itemId: z.string().optional(),
  }),
  output: connectTokenSchema,
  method: 'POST',
  path: '/connections/connect-token',
  kind: 'write',
  expose: API_ONLY,
});

export const connectionsItemsRegister = defineOperation({
  name: 'connections_items_register',
  description:
    'Register a bank item the provider widget just connected (provider + itemId) and discover its upstream accounts (same account shape as connections_upstream_list, amounts in milliunits). Part of the in-app connect flow; idempotent; 409 if another user owns the item; 403 own_keys_required when the caller has no usable key set (see connections_connect_token).',
  input: z.object({ provider: z.string().min(1), itemId: z.string().min(1) }),
  output: connectionRegisteredSchema,
  method: 'POST',
  path: '/connections/items',
  kind: 'write',
  expose: API_ONLY,
});

export const connectionsGet = defineOperation({
  name: 'connections_get',
  description: "Get one of the current user's bank connections (status, institution, last sync). 404 if it is not theirs.",
  input: z.object({ id: connectionId }),
  output: connectionSchema,
  method: 'GET',
  path: '/connections/:id',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const connectionsSyncStatus = defineOperation({
  name: 'connections_sync_status',
  description:
    "Sync status of each of the current user's bank connections: `state` (connected | syncing | queued | queued_offline when the background scheduler is down | reconnect | quota | paused when the connection's key set may not be used, see status_message | error | disconnected), last_synced_at, status_message (user-safe reason), the active run (queued/running) and the last finished run with its user_message. Top-level `scheduler_degraded` is true when the background scheduler is unreachable (syncs wait, nothing is lost).",
  input: z.object({}),
  output: syncStatusSchema,
  method: 'GET',
  path: '/connections/sync-status',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const connectionsSync = defineOperation({
  name: 'connections_sync',
  description:
    "Request a bank sync for every budget account linked to the connection. The sync runs in the background: returns the connection and the `run` (status queued or running; joins a sync already in progress, `created` false). Poll connections_sync_status for the outcome. 404 if the connection is not the current user's.",
  input: z.object({ id: connectionId }),
  output: connectionsSyncResultSchema,
  method: 'POST',
  path: '/connections/:id/sync',
  kind: 'write',
  expose: EXPOSE_ALL,
});

export const connectionsReimport = defineOperation({
  name: 'connections_reimport',
  description:
    "Request a background re-import of full bank history for a connection, ignoring the sync watermark (duplicates are skipped). Back-fills accounts linked after the first sync. Queued after a sync already in progress. Returns the connection and the `run`. 404 if not the current user's.",
  input: z.object({ id: connectionId }),
  output: connectionsSyncResultSchema,
  method: 'POST',
  path: '/connections/:id/reimport',
  kind: 'write',
  expose: EXPOSE_NO_MCP,
});

export const connectionsDelete = defineOperation({
  name: 'connections_delete',
  description:
    'Disconnect a bank connection: removes it at the provider and stops syncing; ledger history stays. 409 while budget accounts are still linked to it; 404 if not the current user\'s.',
  input: z.object({ id: connectionId }),
  output: connectionDeletedSchema,
  method: 'DELETE',
  path: '/connections/:id',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});

export const connectionsSummary = defineOperation({
  name: 'connections_accounts_summary',
  description:
    "Per-account summary of one bank connection's imported transactions, for every budget account linked to it: importedCount (untouched bank rows), editedCount (rows the user changed - the sync stops updating them), removedCount (rows deleted/tombstoned, e.g. gone upstream), totalCount, firstDate/lastDate (YYYY-MM-DD over non-removed rows, null if none) and the budget-side balance in signed integer milliunits (12.34 = 12340). `totals` sums the per-account counts. 404 if the connection is not the current user's.",
  input: z.object({ id: connectionId }),
  output: connectionSummarySchema,
  method: 'GET',
  path: '/connections/:id/summary',
  kind: 'read',
  expose: EXPOSE_ALL,
});

export const connectionsTransactions = defineOperation({
  name: 'connections_transactions_list',
  description:
    "Keyset-paginated transactions one bank connection imported into ONE linked budget account, newest first (date DESC, id DESC). limit 1..200, default 50; pass the previous page's nextCursor as `cursor` (null nextCursor = last page). Each item carries state: imported | edited (changed by the user) | removed (tombstoned/deleted). `amount` is signed integer milliunits (12.34 = 12340). 404 if the connection is not the current user's or the account is not linked to it.",
  input: z.object({
    id: connectionId,
    accountId: uuidSchema.describe('Budget account id (uuid) linked to this connection'),
    cursor: z.string().min(1).max(100).optional().describe('Opaque nextCursor from the previous page'),
    limit: z.coerce.number().int().min(1).max(200).default(50),
  }),
  output: connectionTxnPageSchema,
  method: 'GET',
  path: '/connections/:id/transactions',
  kind: 'read',
  expose: EXPOSE_ALL,
});
