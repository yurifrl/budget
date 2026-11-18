/**
 * Bank-connection wire types — the JSON returned by the API's
 * `/connections/*` operations, derived from their output schemas in
 * `@shared/contracts/connections` (phase 5c, G9) under the names the app
 * already uses.
 *
 * `status` is the generic connection lifecycle ('connected' | 'unauthorized'
 * | 'disconnected' | 'error' | 'quota_exhausted') — see `domain/connections.ts`
 * for the display helpers. Upstream accounts come back camelCase, straight
 * from the adapter port, with amounts in integer MILLIUNITS; the app's domain
 * and screens read them in CENTS, so `externalAccountFromWire` converts them
 * and the `*Json` upstream types below are those cents views (the only shapes
 * here not identical to the wire, built from the wire types).
 */
import type { z } from '@shared/zod';
import type {
  connectTokenSchema,
  connectionAccountSummarySchema,
  connectionCountsSchema,
  connectionSchema,
  connectionSettingsSchema,
  connectionSummarySchema,
  connectionSyncStatusSchema,
  connectionTxnPageSchema,
  connectionTxnSchema,
  connectionTxnStateSchema,
  connectionUpstreamSchema,
  connectionsSyncResultSchema,
  creditDetailsSchema,
  externalAccountSchema,
  linkedBySchema,
  syncCountsSchema,
  syncRunSchema,
  syncStateSchema,
  syncStatusSchema,
} from '@shared/contracts/connections';

/** Who linked a bank: a budget member's name/email/avatar (the app-wide person contract). */
export type LinkedByJson = z.infer<typeof linkedBySchema>;
export type ConnectionJson = z.infer<typeof connectionSchema>;
/** POST /connections/connect-token — widget credentials (token is short-lived, frontend-only). */
export type ConnectTokenJson = z.infer<typeof connectTokenSchema>;
/** Counts a finished sync run reports in `result` (absent when the run skipped). */
export type SyncCountsJson = z.infer<typeof syncCountsSchema>;
/** One background sync run (job ledger row, user-safe fields only). */
export type SyncRunJson = z.infer<typeof syncRunSchema>;
/** POST /connections/:id/sync|reimport — the enqueued (or joined) run; syncing happens in the background. */
export type ConnectionsSyncResult = z.infer<typeof connectionsSyncResultSchema>;
/** Display state derived server-side (connections/domain/sync-state.ts). */
export type SyncState = z.infer<typeof syncStateSchema>;
export type ConnectionSyncStatusJson = z.infer<typeof connectionSyncStatusSchema>;
/** GET /connections/sync-status. */
export type SyncStatusJson = z.infer<typeof syncStatusSchema>;
/** GET/PATCH /connections/settings — the app-global sync window in days; 0 = All history. */
export type ConnectionSettingsJson = z.infer<typeof connectionSettingsSchema>;
/** State of a bank-imported transaction. */
export type ConnectionTxnState = z.infer<typeof connectionTxnStateSchema>;
/** One item of GET /connections/:id/transactions. `amount` is signed MILLIUNITS. */
export type ConnectionTxnJson = z.infer<typeof connectionTxnSchema>;
/** One keyset page; `nextCursor` null = last page. */
export type ConnectionTxnPageJson = z.infer<typeof connectionTxnPageSchema>;
export type ConnectionCountsJson = z.infer<typeof connectionCountsSchema>;
/** One linked budget account in GET /connections/:id/summary. `balance` is signed MILLIUNITS. */
export type ConnectionAccountSummaryJson = z.infer<typeof connectionAccountSummarySchema>;
export type ConnectionSummaryJson = z.infer<typeof connectionSummarySchema>;

// ---------------------------------------------------------------------------
// Upstream amounts: milliunits on the wire, cents in the app (phase 5d)
// ---------------------------------------------------------------------------

/** Credit details as the API sends them (integer milliunits). */
export type CreditDetailsWire = z.infer<typeof creditDetailsSchema>;
/** An upstream account as the API sends it (amounts in integer milliunits). */
export type ExternalAccountWire = z.infer<typeof externalAccountSchema>;
/** GET /connections/upstream row as the API sends it. */
export type ConnectionUpstreamWire = z.infer<typeof connectionUpstreamSchema>;

/** Credit-card details of a CREDIT upstream account, in the app's cents. */
export type CreditDetailsJson = Omit<CreditDetailsWire, 'limit' | 'available' | 'used' | 'minimumPayment' | 'latestBill'> & {
  limitCents: number | null;
  availableCents: number | null;
  usedCents: number | null;
  minimumPaymentCents: number | null;
  latestBill: { totalCents: number | null; dueDate: string | null; minimumPaymentCents: number | null } | null;
};

/** An upstream account discovered for a connection, in the app's cents. */
export type ExternalAccountJson = Omit<ExternalAccountWire, 'balance' | 'credit'> & {
  balanceCents: number | null;
  /** Present for CREDIT accounts. */
  credit?: CreditDetailsJson | null;
};

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
