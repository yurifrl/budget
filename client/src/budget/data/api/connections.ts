/**
 * budgetApi slice: Bank connections (user-scoped) and the account link.
 * Injected into the one `budgetApi` (see ../api.ts); reducer path, tags and
 * cache behaviour are the slice's, unchanged by the split.
 */
import { contractRequest } from '@shared/contract-request';
import { accountsUpdate } from '@shared/contracts/budget';
import { connectionsConnectToken, connectionsCredentialsDelete, connectionsCredentialsGet, connectionsCredentialsSave, connectionsDelete, connectionsGet, connectionsItemsRegister, connectionsList, connectionsReimport, connectionsSettingsGet, connectionsSettingsUpdate, connectionsSettingsUpdateOne, connectionsSummary, connectionsSync, connectionsSyncStatus, connectionsTransactions, connectionsUpstream } from '@shared/contracts/connections';
import type { OperationOutput } from '@shared/operation-contract';
import { type ConnectionCredentialsJson, type ConnectionJson, type ConnectionSettingsJson, type ConnectionsSyncResult, type ConnectionSummaryJson, type ConnectionTxnPageJson, type ConnectionUpstreamJson, type ConnectionUpstreamWire, type ConnectTokenJson, externalAccountFromWire, type ExternalAccountJson, type SyncStatusJson, upstreamFromWire } from '../connections';
import type { AccountRow } from '../rows';
import type { BudgetScope } from './base';
import { registerApi } from './register';

export const connectionsApi = registerApi.injectEndpoints({
  endpoints: (b) => ({
    /** List the user's connections with their statuses (drives re-auth CTAs). */
    getConnections: b.query<ConnectionJson[], void>({
      query: () => contractRequest(connectionsList, {}),
      providesTags: ['Connections'],
    }),

    /** One connection's status — cross-user ids surface as 404. */
    getConnection: b.query<ConnectionJson, { id: string }>({
      query: ({ id }) => contractRequest(connectionsGet, { id }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * Widget credentials for the connect WebView. `itemId` re-auths an
     * existing item instead of creating a duplicate upstream connection.
     */
    createConnectionToken: b.mutation<
      ConnectTokenJson,
      { provider: string; connectorId?: number; itemId?: string }
    >({
      query: ({ provider, connectorId, itemId }) =>
        contractRequest(connectionsConnectToken, {
          provider,
          ...(connectorId != null ? { connectorId } : {}),
          ...(itemId != null ? { itemId } : {}),
        }),
    }),

    /**
     * Register a completed widget item: stores the connection and returns its
     * upstream accounts for the caller to pick the one being linked.
     */
    registerConnection: b.mutation<
      { connection: ConnectionJson; accounts: ExternalAccountJson[] },
      { provider: string; itemId: string }
    >({
      query: ({ provider, itemId }) => contractRequest(connectionsItemsRegister, { provider, itemId }),
      transformResponse: (wire: OperationOutput<typeof connectionsItemsRegister>) => ({
        connection: wire.connection,
        accounts: wire.accounts.map((a) => externalAccountFromWire(a)),
      }),
      invalidatesTags: ['Connections'],
    }),

    /**
     * The caller's own provider key set: client id and whether a secret is
     * stored. The secret never comes back.
     */
    getConnectionCredentials: b.query<ConnectionCredentialsJson, { provider: string }>({
      query: ({ provider }) => contractRequest(connectionsCredentialsGet, { provider }),
      providesTags: ['ConnectionCredentials'],
    }),

    /**
     * Save or replace the own key set. The server checks the pair with the
     * provider first (400 invalid_credentials). Saving resumes or pauses
     * connections, so the connections list is refetched too. Callers reset
     * the mutation once it settles so the secret does not stay in the store.
     */
    saveConnectionCredentials: b.mutation<
      OperationOutput<typeof connectionsCredentialsSave>,
      { provider: string; clientId: string; clientSecret: string }
    >({
      query: ({ provider, clientId, clientSecret }) =>
        contractRequest(connectionsCredentialsSave, { provider, clientId, clientSecret }),
      invalidatesTags: ['ConnectionCredentials', 'Connections'],
    }),

    /** Remove the own key set. Connections made with it are paused, never deleted. */
    deleteConnectionCredentials: b.mutation<OperationOutput<typeof connectionsCredentialsDelete>, { provider: string }>({
      query: ({ provider }) => contractRequest(connectionsCredentialsDelete, { provider }),
      invalidatesTags: ['ConnectionCredentials', 'Connections'],
    }),

    /** Per-account import counts + totals for one connection (bank page Overview). */
    getConnectionSummary: b.query<ConnectionSummaryJson, { id: string }>({
      query: ({ id }) => contractRequest(connectionsSummary, { id }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * One linked account's bank-imported transactions, newest first. Infinite
     * query over the server's keyset cursor: pages load only on demand (pass
     * skipToken until the tab is first opened, then `fetchNextPage`).
     */
    getConnectionTransactions: b.infiniteQuery<
      ConnectionTxnPageJson,
      { id: string; accountId: string },
      string | null
    >({
      infiniteQueryOptions: {
        initialPageParam: null,
        getNextPageParam: (last) => last?.nextCursor ?? undefined,
      },
      query: ({ queryArg, pageParam }) =>
        contractRequest(connectionsTransactions, {
          id: queryArg.id,
          accountId: queryArg.accountId,
          limit: 50,
          ...(pageParam ? { cursor: pageParam } : {}),
        }),
      providesTags: (_r, _e, { id }) => [{ type: 'Connections', id }],
    }),

    /**
     * Per-connection sync state (status pill, active/last run) + scheduler
     * health. Polled by screens while a run is active; never cached long.
     */
    getSyncStatus: b.query<SyncStatusJson, void>({
      query: () => contractRequest(connectionsSyncStatus, {}),
      providesTags: ['Connections'],
    }),

    /**
     * Request a background sync. Returns the queued/running run immediately
     * (joins one already in flight); callers poll `getSyncStatus` for the
     * outcome and invalidate data tags when it lands (see useSyncRunner).
     */
    syncConnection: b.mutation<ConnectionsSyncResult, { id: string; budgetId: string }>({
      query: ({ id }) => contractRequest(connectionsSync, { id }),
      invalidatesTags: ['Connections'],
    }),

    /** Request a background re-import: watermark-ignoring pull over the full window (deduped). */
    reimportHistory: b.mutation<ConnectionsSyncResult, { id: string; budgetId: string }>({
      query: ({ id }) => contractRequest(connectionsReimport, { id }),
      invalidatesTags: ['Connections'],
    }),

    /** Disconnect: remove upstream and flip the row out of the poller's reach. */
    disconnectConnection: b.mutation<{ ok: boolean }, { id: string; budgetId: string }>({
      query: ({ id }) => contractRequest(connectionsDelete, { id }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        'Connections',
        { type: 'Accounts', id: budgetId },
      ],
    }),

    /**
     * Every live connection's upstream accounts with their 1:1 link state —
     * the bank-link chooser's single data pull.
     */
    getUpstreamAccounts: b.query<ConnectionUpstreamJson[], void>({
      query: () => contractRequest(connectionsUpstream, {}),
      transformResponse: (wire: ConnectionUpstreamWire[]) => upstreamFromWire(wire),
      providesTags: ['Connections'],
    }),

    /** App-global sync-window config (how far back pulls reach; 0 = all). */
    getConnectionSettings: b.query<ConnectionSettingsJson, void>({
      query: () => contractRequest(connectionsSettingsGet, {}),
      providesTags: ['Connections'],
    }),

    /** Change the sync window. Rejects out-of-bounds days (server-validated). */
    updateSyncWindow: b.mutation<ConnectionSettingsJson, { syncWindowDays: number }>({
      query: ({ syncWindowDays }) => contractRequest(connectionsSettingsUpdate, { syncWindowDays }),
      invalidatesTags: ['Connections'],
    }),

    /** Per-bank sync window (days; 0 = all history; null = inherit the app default). */
    updateConnectionSyncWindow: b.mutation<ConnectionJson, { id: string; syncWindowDays: number | null }>({
      query: ({ id, syncWindowDays }) => contractRequest(connectionsSettingsUpdateOne, { id, syncWindowDays }),
      invalidatesTags: ['Connections'],
    }),

    /**
     * Link / unlink an account to a connection's upstream account. Null
     * `connectionId` unlinks; linking requires `externalAccountId`.
     */
    linkAccount: b.mutation<
      AccountRow,
      BudgetScope & {
        accountId: string;
        connectionId: string | null;
        externalAccountId?: string;
        institution?: string | null;
      }
    >({
      query: ({ budgetId, accountId, connectionId, externalAccountId, institution }) =>
        contractRequest(accountsUpdate, {
          id: accountId,
          budget_id: budgetId,
          // Unlink is an object with a null connectionId — the contract validates
          // `link` as an optional object, so a bare null would be rejected.
          link: {
            connectionId,
            externalAccountId: externalAccountId ?? null,
            ...(institution !== undefined ? { institution } : {}),
          },
        }),
      invalidatesTags: (_r, _e, { budgetId }) => [
        { type: 'Accounts', id: budgetId },
        'Connections',
      ],
    }),
  }),
});
