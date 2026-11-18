/**
 * Bank-connection wire types — the JSON shapes returned by the Hono API's
 * `/connections/*` routes (mirrors `connectionJson` in
 * `server/routes/connections.ts`; dates are ISO strings over the wire).
 *
 * `status` is the generic connection lifecycle ('connected' | 'unauthorized'
 * | 'disconnected' | 'error') — see `domain/connections.ts` for the display
 * helpers. Upstream accounts come back camelCase, straight from the adapter
 * port (`server/connections/types.ts`).
 */

/** Who linked a bank: a budget member's name/email/avatar (the app-wide person contract). */
export interface LinkedByJson {
  user_id: string;
  name: string | null;
  email: string | null;
  avatar: { seed: string; image_version: number | null };
}

export interface ConnectionJson {
  id: string;
  provider: string;
  external_id: string;
  client_user_id: string;
  status: 'connected' | 'unauthorized' | 'disconnected' | 'error' | 'quota_exhausted';
  /** Sanitized, user-facing reason for a non-connected status. */
  status_message: string | null;
  environment: 'sandbox' | 'production';
  institution: string | null;
  last_synced_at: string | null;
  /** Per-bank sync-window override in days; null inherits the app-wide default. */
  sync_window_days: number | null;
  /** Who linked the bank. */
  linked_by: LinkedByJson | null;
  created_at: string;
  updated_at: string;
}

/** Credit-card details of a CREDIT upstream account, in the app's cents (converted from the wire's milliunits by `externalAccountFromWire`). */
export interface CreditDetailsJson {
  limitCents: number | null;
  availableCents: number | null;
  usedCents: number | null;
  minimumPaymentCents: number | null;
  dueDate: string | null;
  latestBill: { totalCents: number | null; dueDate: string | null; minimumPaymentCents: number | null } | null;
}

/** An upstream account discovered for a connection, in the app's cents (the wire carries milliunits). */
export interface ExternalAccountJson {
  externalId: string;
  name: string;
  type: 'BANK' | 'CREDIT';
  currencyCode: string | null;
  balanceCents: number | null;
  institution: string | null;
  /** Present for CREDIT accounts. */
  credit?: CreditDetailsJson | null;
}

/** POST /connections/connect-token — widget credentials (token is short-lived, frontend-only). */
export interface ConnectTokenJson {
  token: string;
  clientId: string;
  widgetUrl: string | null;
}

/** Counts a finished sync run reports in `result` (absent when the run skipped). */
export interface SyncCountsJson {
  added: number;
  updated: number;
  deleted: number;
  blocked: number;
  duplicates: number;
}

/** One background sync run (job ledger row, user-safe fields only). */
export interface SyncRunJson {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  mode: 'sync' | 'reimport';
  created_at: string;
  finished_at: string | null;
  /** Sanitized failure/notice text; null on a plain success. */
  user_message: string | null;
  result: (Partial<SyncCountsJson> & { skipped?: string }) | null;
}

/** POST /connections/:id/sync|reimport — the enqueued (or joined) run; syncing happens in the background. */
export interface ConnectionsSyncResult {
  connection: ConnectionJson;
  run: SyncRunJson;
  /** False when the request joined a run already in flight. */
  created: boolean;
}

/** Display state derived server-side (server/connections/domain/sync-state.ts). */
export type SyncState =
  | 'connected'
  | 'syncing'
  | 'queued'
  | 'queued_offline'
  | 'reconnect'
  | 'quota'
  | 'error'
  | 'disconnected';

export interface ConnectionSyncStatusJson {
  id: string;
  institution: string | null;
  status: ConnectionJson['status'];
  status_message: string | null;
  last_synced_at: string | null;
  state: SyncState;
  active_run: SyncRunJson | null;
  last_run: SyncRunJson | null;
}

/** GET /connections/sync-status. */
export interface SyncStatusJson {
  /** True when the background scheduler is unreachable: syncs wait, nothing is lost. */
  scheduler_degraded: boolean;
  scheduler_reason?: string;
  connections: ConnectionSyncStatusJson[];
}

/** One upstream account with its 1:1 link state (null = unlinked). */
export type UpstreamAccountJson = ExternalAccountJson & {
  /** The budget account currently linked to this upstream account, if any. */
  linkedAccountId: string | null;
};

/**
 * GET /connections/upstream — every live connection's upstream accounts in one
 * pull (the bank-link chooser's data source). `accounts: null` = the provider
 * call failed for that connection (e.g. re-auth needed); the row still renders
 * with its connection status.
 */
export interface ConnectionUpstreamJson {
  connection: ConnectionJson;
  accounts: UpstreamAccountJson[] | null;
}

/**
 * GET/PATCH /connections/settings — the app-global sync window: how far back
 * a pull reaches, in days. 0 = All history (no lower bound sent upstream).
 */
export interface ConnectionSettingsJson {
  syncWindowDays: number;
}

/** State of a bank-imported transaction (server `STATE_SQL`). */
export type ConnectionTxnState = 'imported' | 'edited' | 'removed';

/** One item of GET /connections/:id/transactions. `amount` is signed MILLIUNITS (cents x 10). */
export interface ConnectionTxnJson {
  id: string;
  date: string;
  amount: number;
  payee: string | null;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  state: ConnectionTxnState;
}

/** One keyset page; `nextCursor` null = last page. */
export interface ConnectionTxnPageJson {
  items: ConnectionTxnJson[];
  nextCursor: string | null;
}

export interface ConnectionCountsJson {
  importedCount: number;
  editedCount: number;
  removedCount: number;
  totalCount: number;
}

/** One linked budget account in GET /connections/:id/summary. `balance` is signed MILLIUNITS. */
export interface ConnectionAccountSummaryJson extends ConnectionCountsJson {
  accountId: string;
  name: string;
  type: string;
  externalAccountId: string | null;
  balance: number;
  firstDate: string | null;
  lastDate: string | null;
}

export interface ConnectionSummaryJson {
  connectionId: string;
  accounts: ConnectionAccountSummaryJson[];
  totals: ConnectionCountsJson;
}

// ---------------------------------------------------------------------------
// Upstream amounts: milliunits on the wire, cents in the app (phase 5d)
// ---------------------------------------------------------------------------

/** Credit details as the API sends them (integer milliunits). */
export interface CreditDetailsWire {
  limit: number | null;
  available: number | null;
  used: number | null;
  minimumPayment: number | null;
  dueDate: string | null;
  latestBill: { total: number | null; dueDate: string | null; minimumPayment: number | null } | null;
}

/** An upstream account as the API sends it (amounts in integer milliunits). */
export interface ExternalAccountWire {
  externalId: string;
  name: string;
  type: 'BANK' | 'CREDIT';
  currencyCode: string | null;
  balance: number | null;
  institution: string | null;
  credit?: CreditDetailsWire | null;
}

export interface ConnectionUpstreamWire {
  connection: ConnectionJson;
  accounts: (ExternalAccountWire & { linkedAccountId: string | null })[] | null;
}

const centsOrNull = (milli: number | null): number | null => (milli == null ? null : Math.round(milli / 10));

/** Wire (milliunits) -> the app's cents-shaped upstream account. */
export function externalAccountFromWire<T extends ExternalAccountWire>(
  wire: T,
): Omit<T, 'balance' | 'credit'> & ExternalAccountJson {
  const { balance, credit, ...rest } = wire;
  const out = { ...rest, balanceCents: centsOrNull(balance) } as Omit<T, 'balance' | 'credit'> & ExternalAccountJson;
  if (credit !== undefined) {
    out.credit =
      credit === null
        ? null
        : {
            limitCents: centsOrNull(credit.limit),
            availableCents: centsOrNull(credit.available),
            usedCents: centsOrNull(credit.used),
            minimumPaymentCents: centsOrNull(credit.minimumPayment),
            dueDate: credit.dueDate,
            latestBill:
              credit.latestBill == null
                ? null
                : {
                    totalCents: centsOrNull(credit.latestBill.total),
                    dueDate: credit.latestBill.dueDate,
                    minimumPaymentCents: centsOrNull(credit.latestBill.minimumPayment),
                  },
          };
  }
  return out;
}

export function upstreamFromWire(rows: readonly ConnectionUpstreamWire[]): ConnectionUpstreamJson[] {
  return rows.map((row) => ({
    connection: row.connection,
    accounts: row.accounts === null ? null : row.accounts.map((a) => externalAccountFromWire(a)),
  }));
}
