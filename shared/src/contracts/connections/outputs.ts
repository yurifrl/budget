/**
 * Output (response) schemas of the connections operations, transcribed from
 * the client's former hand-written `client/src/budget/data/connections.ts`
 * (which now derives its wire types from these). Upstream accounts come back
 * camelCase, straight from the adapter port; every amount is integer
 * milliunits (`MONEY_UNIT_RULE`). Objects are non-strict.
 */
import { z } from '../../zod';

const id = z.string();
const nullableString = z.string().nullable();
const milli = z.number().int();

export const linkedBySchema = z.object({
  user_id: id,
  name: nullableString,
  email: nullableString,
  avatar: z.object({ seed: z.string(), image_version: z.number().nullable() }),
});

/**
 * `paused`: the key set that created the connection may not be used by its
 * owner right now (shared keys without the 'shared-pluggy-key' feature, or own
 * keys that were removed or replaced). Nothing syncs; `status_message` says
 * what the user must do. It resumes by itself when the key set is usable again.
 */
export const connectionStatusSchema = z.enum(['connected', 'unauthorized', 'disconnected', 'error', 'quota_exhausted', 'paused']);

/** Which key set created the upstream item: the installation's shared keys or the owner's own. */
export const connectionKeySourceSchema = z.enum(['shared', 'own']);

export const connectionSchema = z.object({
  id,
  provider: z.string(),
  external_id: z.string(),
  client_user_id: nullableString,
  status: connectionStatusSchema,
  /** Sanitized, user-facing reason for a non-connected status. */
  status_message: nullableString,
  /** Code of the stored server sentence in `status_message` (`server_*`, see shared/src/errors.ts); null when the text is not one of them. Additive (always sent by the API; optional in the type so older fixtures still compile). */
  status_message_code: nullableString.optional(),
  /** 'sandbox' | 'production' as the adapter reports it; nullable text in the table. */
  environment: nullableString,
  /** Key set the connection was created with; it can only ever be reached with that one. */
  key_source: connectionKeySourceSchema,
  institution: nullableString,
  last_synced_at: nullableString,
  /** Per-bank sync-window override in days; null inherits the app-wide default. */
  sync_window_days: z.number().nullable(),
  /** Who linked the bank. */
  linked_by: linkedBySchema.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** Credit-card details of a CREDIT upstream account (integer milliunits, magnitudes). */
export const creditDetailsSchema = z.object({
  limit: milli.nullable(),
  available: milli.nullable(),
  used: milli.nullable(),
  minimumPayment: milli.nullable(),
  dueDate: nullableString,
  latestBill: z
    .object({ total: milli.nullable(), dueDate: nullableString, minimumPayment: milli.nullable() })
    .nullable(),
});

/** An upstream account discovered for a connection. */
export const externalAccountSchema = z.object({
  externalId: z.string(),
  name: z.string(),
  type: z.enum(['BANK', 'CREDIT']),
  /** ISO 4217 code as the provider reports it. */
  currencyCode: nullableString,
  /** Signed integer milliunits; null when the provider did not report a balance. */
  balance: milli.nullable(),
  institution: nullableString,
  /** Present for CREDIT accounts. */
  credit: creditDetailsSchema.nullable().optional(),
});

/** One upstream account with its 1:1 link state (null = unlinked). */
export const upstreamAccountSchema = externalAccountSchema.extend({ linkedAccountId: id.nullable() });

/** GET /connections/upstream row. `accounts: null` = the provider call failed for that connection. */
export const connectionUpstreamSchema = z.object({
  connection: connectionSchema,
  accounts: z.array(upstreamAccountSchema).nullable(),
});

export const connectionRegisteredSchema = z.object({ connection: connectionSchema, accounts: z.array(externalAccountSchema) });

/** POST /connections/connect-token — widget credentials (token is short-lived, frontend-only). */
export const connectTokenSchema = z.object({ token: z.string(), clientId: nullableString, widgetUrl: nullableString });

export const syncCountsSchema = z.object({
  added: z.number(),
  updated: z.number(),
  deleted: z.number(),
  blocked: z.number(),
  duplicates: z.number(),
});

/** One background sync run (job ledger row, user-safe fields only). */
export const syncRunSchema = z.object({
  id,
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']),
  mode: z.enum(['sync', 'reimport']),
  created_at: z.string(),
  finished_at: nullableString,
  /** Sanitized failure/notice text; null on a plain success. */
  user_message: nullableString,
  /** Code of the stored server sentence in `user_message` (`server_*`, see shared/src/errors.ts); null when the text is not one of them. Additive (always sent by the API; optional in the type so older fixtures still compile). */
  user_message_code: nullableString.optional(),
  result: syncCountsSchema.partial().extend({ skipped: z.string().optional() }).nullable(),
});

/** POST /connections/:id/sync|reimport — the enqueued (or joined) run. */
export const connectionsSyncResultSchema = z.object({
  connection: connectionSchema,
  run: syncRunSchema,
  /** False when the request joined a run already in flight. */
  created: z.boolean(),
});

/** Display state derived server-side (connections/domain/sync-state.ts). */
export const syncStateSchema = z.enum([
  'connected',
  'syncing',
  'queued',
  'queued_offline',
  'reconnect',
  'quota',
  'paused',
  'error',
  'disconnected',
]);

export const connectionSyncStatusSchema = z.object({
  id,
  institution: nullableString,
  status: connectionStatusSchema,
  status_message: nullableString,
  /** Code of the stored server sentence in `status_message` (`server_*`); null when unknown. Additive. */
  status_message_code: nullableString.optional(),
  last_synced_at: nullableString,
  state: syncStateSchema,
  active_run: syncRunSchema.nullable(),
  last_run: syncRunSchema.nullable(),
});

/** GET /connections/sync-status. */
export const syncStatusSchema = z.object({
  /** True when the background scheduler is unreachable: syncs wait, nothing is lost. */
  scheduler_degraded: z.boolean(),
  scheduler_reason: z.string().optional(),
  connections: z.array(connectionSyncStatusSchema),
});

/** GET/PATCH /connections/settings — the app-global sync window in days (0 = all history). */
export const connectionSettingsSchema = z.object({ syncWindowDays: z.number() });

export const connectionTxnStateSchema = z.enum(['imported', 'edited', 'removed']);

/** One item of GET /connections/:id/transactions. `amount` is signed milliunits. */
export const connectionTxnSchema = z.object({
  id,
  date: z.string(),
  amount: milli,
  payee: nullableString,
  memo: nullableString,
  cleared: z.enum(['cleared', 'uncleared', 'reconciled']),
  state: connectionTxnStateSchema,
});

/** One keyset page; `nextCursor` null = last page. */
export const connectionTxnPageSchema = z.object({ items: z.array(connectionTxnSchema), nextCursor: nullableString });

export const connectionCountsSchema = z.object({
  importedCount: z.number(),
  editedCount: z.number(),
  removedCount: z.number(),
  totalCount: z.number(),
});

/**
 * One linked budget account in GET /connections/:id/summary. `balance` is signed
 * milliunits. `budgetId` is the budget the account lives in: a connection is
 * per user, so its accounts may sit in a budget other than the active one.
 */
export const connectionAccountSummarySchema = connectionCountsSchema.extend({
  accountId: id,
  budgetId: id,
  name: z.string(),
  type: z.string(),
  externalAccountId: nullableString,
  balance: milli,
  firstDate: nullableString,
  lastDate: nullableString,
});

export const connectionSummarySchema = z.object({
  connectionId: id,
  accounts: z.array(connectionAccountSummarySchema),
  totals: connectionCountsSchema,
});

export const connectionDeletedSchema = z.object({ ok: z.boolean() });

/**
 * The caller's own key set for a provider (GET/PUT /connections/credentials).
 * The secret itself is never returned: `hasSecret` only says one is stored.
 * `clientId` and `updatedAt` are null when the caller has saved no key set.
 */
export const connectionCredentialsSchema = z.object({
  provider: z.string(),
  clientId: nullableString,
  hasSecret: z.boolean(),
  updatedAt: nullableString,
});
