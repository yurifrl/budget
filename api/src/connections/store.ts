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

import { pool } from '../core/db';
import { personRefSql, toPersonRef, type PersonRef, type PersonRefRow } from '../user';
import { HttpError } from '../core/validate';

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
  'id, user_id, provider, external_id, client_user_id, status, status_message, environment, institution, ' +
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
      throw new HttpError(409, 'conflict — connection already registered by another user');
    }
    const updated = await pool.query<ConnectionRow>(
      `update public.connections
         set client_user_id = $2, status = $3, status_message = null, environment = $4, institution = $5, updated_at = now()
       where id = $1
       returning ${CONNECTION_COLUMNS}`,
      [row.id, input.clientUserId ?? null, input.status, input.environment ?? null, input.institution ?? null],
    );
    return updated.rows[0]!;
  }

  const inserted = await pool.query<ConnectionRow>(
    `insert into public.connections
       (id, user_id, provider, external_id, client_user_id, status, environment, institution)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
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
       set status = 'disconnected', status_message = null, next_poll_at = null, updated_at = now()
     where id = $1`,
    [id],
  );
}

/**
 * Set the lifecycle status with its user-facing message (null clears it).
 * `pausedUntil` is only meaningful for 'quota_exhausted'; any other status
 * clears it so the sweep considers the connection again.
 */
export async function setConnectionStatus(
  id: string,
  status: string,
  message: string | null,
  pausedUntil: Date | null = null,
): Promise<void> {
  await pool.query(
    `update public.connections
       set status = $2, status_message = $3, next_poll_at = $4, updated_at = now()
     where id = $1 and status <> 'disconnected'`,
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
export async function listSweepConnections(now: Date): Promise<ConnectionRow[]> {
  const rows = await pool.query<ConnectionRow>(
    `select ${CONNECTION_COLUMNS}
     from public.connections
     where environment is distinct from 'sandbox'
       and (status = 'connected'
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
