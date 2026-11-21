/**
 * Connections persistence (v1.1 Phase 4 — db/migrations/0014_connections.sql).
 *
 * One `connections` row per bank link: a user connects a provider item, the
 * adapter stores its upstream id in `external_id` and its connect-flow
 * identity in `client_user_id`. `external_id` is unique per provider — a
 * second user claiming the same upstream item is a conflict, not a re-claim.
 *
 * There is no mirror account table: the bank link is a property of the budget
 * `accounts` row (`connection_id` + `external_account_id`, set through the
 * accounts route), and the sync engine joins on those columns directly.
 *
 * `connection_events` is the webhook dedupe ledger — one row per processed
 * (provider, eventId); replays answer 200 without re-applying effects. The
 * connections sweep prunes it (30-day retention).
 */

import { pool, type Queryable } from '../core/db';
import { personRefSql, toPersonRef, type PersonRef, type PersonRefRow } from '../user';
import { HttpError } from '../core/validate';
import { PAUSE_MESSAGES } from './errors';
import type { KeySource } from './types';

export type ConnectionRow = {
  id: string;
  user_id: string;
  provider: string;
  external_id: string;
  client_user_id: string | null;
  status: string;
  /** Sanitized user-facing reason for a non-connected status. */
  status_message: string | null;
  environment: string | null;
  /** Key set that created the upstream item: 'shared' or 'own' (migration 0104). */
  key_source: KeySource;
  /** For 'own': the client id the item was created with; null for 'shared'. */
  key_client_id: string | null;
  institution: string | null;
  last_synced_at: Date | null;
  next_poll_at: Date | null;
  poll_failures: number;
  /** Per-connection window override; null inherits the app-wide setting. */
  sync_window_days: number | null;
  created_at: Date;
  updated_at: Date;
};

/** A connection plus who linked it (the owner's name/email/avatar). */
export type ConnectionWithLinker = ConnectionRow & { linked_by: PersonRef | null };

const CONNECTION_COLUMNS =
  'id, user_id, provider, external_id, client_user_id, status, status_message, environment, key_source, key_client_id, institution, ' +
  'last_synced_at, next_poll_at, poll_failures, sync_window_days, created_at, updated_at';

/**
 * Register (or re-claim) a connected provider item. The upstream item id is
 * globally unique per provider: another user's claim is a 409, the owner's
 * re-connect updates identity/status in place.
 */
export async function upsertConnection(input: {
  userId: string;
  provider: string;
  externalId: string;
  clientUserId?: string | null;
  status: string;
  institution?: string | null;
  environment?: string | null;
  /**
   * Key set the item was created with. Written on INSERT only: an item never
   * moves between key sets, so re-registering keeps what the row recorded.
   */
  keySource?: KeySource;
  keyClientId?: string | null;
}): Promise<ConnectionRow> {
  const existing = await pool.query<ConnectionRow>(
    `select ${CONNECTION_COLUMNS}
     from public.connections
     where provider = $1 and external_id = $2`,
    [input.provider, input.externalId],
  );

  if (existing.rowCount != null && existing.rowCount > 0) {
    const row = existing.rows[0]!;
    if (row.user_id !== input.userId) {
      throw new HttpError(409, 'conflict — connection already registered by another user', 'connection_already_registered');
    }
    const updated = await pool.query<ConnectionRow>(
      `update public.connections
         set client_user_id = $2, status = $3, status_message = null, paused_from = null, environment = $4, institution = $5, updated_at = now()
       where id = $1
       returning ${CONNECTION_COLUMNS}`,
      [row.id, input.clientUserId ?? null, input.status, input.environment ?? null, input.institution ?? null],
    );
    return updated.rows[0]!;
  }

  const inserted = await pool.query<ConnectionRow>(
    `insert into public.connections
       (id, user_id, provider, external_id, client_user_id, status, environment, institution, key_source, key_client_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     returning ${CONNECTION_COLUMNS}`,
    [
      crypto.randomUUID(),
      input.userId,
      input.provider,
      input.externalId,
      input.clientUserId ?? null,
      input.status,
      input.environment ?? null,
      input.institution ?? null,
      input.keySource ?? 'shared',
      input.keySource === 'own' ? (input.keyClientId ?? null) : null,
    ],
  );
  return inserted.rows[0]!;
}

/** Same columns, qualified for the `c` (connections) / `u` (owner) join. */
const LINKED_SELECT = `${CONNECTION_COLUMNS.split(', ').map((col) => `c.${col}`).join(', ')}, ${personRefSql('u')}`;

const withLinker = (row: ConnectionRow & PersonRefRow): ConnectionWithLinker => {
  const { ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version, ...connection } = row;
  return {
    ...connection,
    linked_by: toPersonRef({ ref_user_id, ref_name, ref_email, avatar_seed, avatar_image_version }),
  };
};

/** All connections (newest first) for a user, each with its `linked_by` person. */
export async function listConnectionsByUser(userId: string): Promise<ConnectionWithLinker[]> {
  const rows = await pool.query<ConnectionRow & PersonRefRow>(
    `select ${LINKED_SELECT}
     from public.connections c
     join public.users u on u.id = c.user_id
     where c.user_id = $1
     order by c.created_at desc`,
    [userId],
  );
  return rows.rows.map(withLinker);
}

/** One connection scoped to its owner — cross-user ids surface as null. */
export async function getConnectionByUser(userId: string, id: string): Promise<ConnectionWithLinker | null> {
  const row = await pool.query<ConnectionRow & PersonRefRow>(
    `select ${LINKED_SELECT}
     from public.connections c
     join public.users u on u.id = c.user_id
     where c.user_id = $1 and c.id = $2`,
    [userId, id],
  );
  return row.rows[0] ? withLinker(row.rows[0]) : null;
}

/** Attach `linked_by` to a row a write just returned (one fetch; the row exists). */
export async function withLinkedBy(row: ConnectionRow): Promise<ConnectionWithLinker> {
  const fetched = await getConnectionByUser(row.user_id, row.id);
  return fetched ?? { ...row, linked_by: null };
}

/** Stamp the institution discovered at register time. */
export async function setConnectionInstitution(id: string, institution: string): Promise<ConnectionRow> {
  const updated = await pool.query<ConnectionRow>(
    `update public.connections
       set institution = $2, updated_at = now()
     where id = $1
     returning ${CONNECTION_COLUMNS}`,
    [id, institution],
  );
  return updated.rows[0]!;
}

/** Set (or clear with null) a connection's own sync window; null = inherit the app default. */
export async function setConnectionSyncWindow(id: string, days: number | null): Promise<ConnectionRow> {
  const updated = await pool.query<ConnectionRow>(
    `update public.connections
       set sync_window_days = $2, updated_at = now()
     where id = $1
     returning ${CONNECTION_COLUMNS}`,
    [id, days],
  );
  return updated.rows[0]!;
}

/** Budget accounts linked to a connection (the link lives on accounts). */
export async function linkedAccounts(connectionId: string): Promise<Array<{ id: string; external_account_id: string }>> {
  const rows = await pool.query<{ id: string; external_account_id: string }>(
    `select id, external_account_id
     from public.accounts
     where connection_id = $1 and external_account_id is not null`,
    [connectionId],
  );
  return rows.rows;
}

/**
 * Disconnect locally: keep the row (its ledger rows and history persist) but
 * flip it out of the sweep's reach.
 */
export async function markDisconnected(id: string): Promise<void> {
  await pool.query(
    `update public.connections
       set status = 'disconnected', status_message = null, next_poll_at = null, paused_from = null, updated_at = now()
     where id = $1`,
    [id],
  );
}

/**
 * Set the lifecycle status with its user-facing message (null clears it).
 * `pausedUntil` is only meaningful for 'quota_exhausted'; any other status
 * clears it so the sweep considers the connection again.
 */
// A 'paused' row is left alone too: only reconcilePausedConnections (or a
// disconnect, or a fresh register) may take a row out of 'paused'. A webhook
// event or a sync that finishes after the pause must not un-pause it.
export async function setConnectionStatus(
  id: string,
  status: string,
  message: string | null,
  pausedUntil: Date | null = null,
): Promise<void> {
  await pool.query(
    `update public.connections
       set status = $2, status_message = $3, next_poll_at = $4, updated_at = now()
     where id = $1 and status not in ('disconnected', 'paused')`,
    [id, status, message, pausedUntil],
  );
}

/** Webhook lookup: the connection for a provider's upstream item id. */
export async function getConnectionByExternal(provider: string, externalId: string): Promise<ConnectionRow | null> {
  const rows = await pool.query<ConnectionRow>(
    `select ${CONNECTION_COLUMNS} from public.connections where provider = $1 and external_id = $2`,
    [provider, externalId],
  );
  return rows.rows[0] ?? null;
}

/** Connection by id with no owner scope — job activities only (the job carries the tenant). */
export async function getConnectionById(id: string): Promise<ConnectionRow | null> {
  const rows = await pool.query<ConnectionRow>(`select ${CONNECTION_COLUMNS} from public.connections where id = $1`, [id]);
  return rows.rows[0] ?? null;
}

/**
 * Connections the 6h sweep should look at: live ones (`connected`, or a quota
 * pause that has expired). `unauthorized`/`error`/`disconnected` need the user
 * or a webhook, and sandbox items never auto-sync (provider sandboxes churn
 * data hourly).
 */
// Also: 'paused' rows (the sweep is what resumes them) and OWN-key rows in
// 'error' (they get no webhook, so nothing else would ever retry them).
// Shared-key 'error' rows still wait for the user or a webhook, as before.
export async function listSweepConnections(now: Date): Promise<ConnectionRow[]> {
  const rows = await pool.query<ConnectionRow>(
    `select ${CONNECTION_COLUMNS}
     from public.connections
     where environment is distinct from 'sandbox'
       and (status in ('connected', 'paused')
            or (status = 'error' and key_source = 'own')
            or (status = 'quota_exhausted' and (next_poll_at is null or next_poll_at <= $1)))
     order by created_at`,
    [now],
  );
  return rows.rows;
}

/**
 * Record one inbound webhook delivery; true only for the first sighting of
 * this eventId (provider-scoped dedupe lives in the route via the ledger's
 * per-event primary key).
 */
export async function recordWebhookEvent(input: {
  eventId: string;
  provider: string;
  externalItemId: string | null;
  payload: unknown;
  now: Date;
}): Promise<boolean> {
  const result = await pool.query(
    `insert into public.connection_events
       (event_id, provider, external_item_id, payload, received_at)
     values ($1, $2, $3, $4, $5)
     on conflict (event_id) do nothing`,
    [input.eventId, input.provider, input.externalItemId, JSON.stringify(input.payload ?? {}), input.now],
  );
  return (result.rowCount ?? 0) === 1;
}

/** Undo recordWebhookEvent (the delivery's effects failed and must be retried). */
export async function forgetWebhookEvent(eventId: string): Promise<void> {
  await pool.query('delete from public.connection_events where event_id = $1', [eventId]);
}

/** Retention prune for the webhook ledger; returns the removed row count. */
export async function pruneConnectionEvents(olderThan: Date): Promise<number> {
  const result = await pool.query(
    `delete from public.connection_events
     where received_at < $1`,
    [olderThan],
  );
  return result.rowCount ?? 0;
}

// ---- key sets ----------------------------------------------------------------

/**
 * Pause and resume one user's connections so `status` follows whether each
 * connection's key set may be used right now (rules: ./keys.ts):
 *   shared → usable while `sharedAllowed` (the 'shared-pluggy-key' feature);
 *   own    → usable while the owner stores a key set with the client id the
 *            connection was created with.
 * Not usable → 'paused' with the matching message, remembering in
 * `paused_from` the status, message and quota pause-until the row had; usable
 * again → that state is restored (so an unauthorized or quota-paused bank does
 * not come back looking healthy), 'connected' when nothing was remembered.
 * Only this function takes a row out of 'paused'.
 * Disconnected rows are never touched. Two statements, idempotent, so it is
 * safe to run on every read. Returns how many rows changed.
 */
export async function reconcilePausedConnections(db: Queryable, userId: string, sharedAllowed: boolean): Promise<number> {
  const usable = `((c.key_source = 'shared' and $2::boolean)
        or (c.key_source = 'own' and exists (
              select 1 from public.connection_credentials k
               where k.user_id = c.user_id and k.provider = c.provider and k.client_id = c.key_client_id)))`;
  const paused = await db.query(
    `update public.connections c
        set paused_from = jsonb_build_object('status', c.status, 'status_message', c.status_message, 'next_poll_at', c.next_poll_at),
            status = 'paused',
            status_message = case when c.key_source = 'own' then $4 else $3 end,
            next_poll_at = null, updated_at = now()
      where c.user_id = $1 and c.status not in ('disconnected', 'paused') and not ${usable}`,
    [userId, sharedAllowed, PAUSE_MESSAGES.shared, PAUSE_MESSAGES.own],
  );
  const resumed = await db.query(
    `update public.connections c
        set status = case when c.paused_from->>'status' in ('unauthorized', 'error', 'quota_exhausted') then c.paused_from->>'status' else 'connected' end,
            status_message = case when c.paused_from->>'status' in ('unauthorized', 'error', 'quota_exhausted') then c.paused_from->>'status_message' end,
            next_poll_at = case when c.paused_from->>'status' = 'quota_exhausted' then (c.paused_from->>'next_poll_at')::timestamptz end,
            paused_from = null, updated_at = now()
      where c.user_id = $1 and c.status = 'paused' and ${usable}`,
    [userId, sharedAllowed],
  );
  return (paused.rowCount ?? 0) + (resumed.rowCount ?? 0);
}

/** A user's own key set as stored: the secret only as ciphertext + nonce. */
export type StoredCredentials = {
  user_id: string;
  provider: string;
  client_id: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  key_version: number;
  created_at: Date;
  updated_at: Date;
};

const CREDENTIAL_COLUMNS = 'user_id, provider, client_id, secret_ciphertext, secret_nonce, key_version, created_at, updated_at';

/** The user's own key set for `provider`, or null. */
export async function getCredentials(db: Queryable, userId: string, provider: string): Promise<StoredCredentials | null> {
  const { rows } = await db.query<StoredCredentials>(
    `select ${CREDENTIAL_COLUMNS} from public.connection_credentials where user_id = $1 and provider = $2`,
    [userId, provider],
  );
  return rows[0] ?? null;
}

/** Save or replace the user's own key set (one per user and provider). */
export async function saveCredentials(
  db: Queryable,
  input: { userId: string; provider: string; clientId: string; ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number },
): Promise<StoredCredentials> {
  const { rows } = await db.query<StoredCredentials>(
    `insert into public.connection_credentials (user_id, provider, client_id, secret_ciphertext, secret_nonce, key_version)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id, provider) do update
       set client_id = excluded.client_id, secret_ciphertext = excluded.secret_ciphertext,
           secret_nonce = excluded.secret_nonce, key_version = excluded.key_version, updated_at = now()
     returning ${CREDENTIAL_COLUMNS}`,
    [input.userId, input.provider, input.clientId, Buffer.from(input.ciphertext), Buffer.from(input.nonce), input.keyVersion],
  );
  return rows[0]!;
}

/** Delete the user's own key set; false when there was none. */
export async function deleteCredentials(db: Queryable, userId: string, provider: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from public.connection_credentials where user_id = $1 and provider = $2', [userId, provider]);
  return (rowCount ?? 0) > 0;
}
