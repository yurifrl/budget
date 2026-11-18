/**
 * Connections data routes (v1.1 Phase 4). All paths live under /connections
 * and every data path is user-scoped: `user` is resolved globally by
 * requireUser (server/user/middleware), and cross-user ids surface as 404 — never
 * 403.
 *
 *   POST   /connect-token  → connect token bundle for the provider's widget
 *   POST   /items          → register a connected provider item; the response
 *                            carries the discovered upstream accounts so the
 *                            UI can offer them as link candidates (the link
 *                            itself lives on the budget accounts row —
 *                            PATCH /accounts/:id, see server/budget/routes/accounts)
 *   GET    /               → list this user's connections (status → re-auth CTA)
 *   GET    /:id            → one connection's status
 *   PATCH  /:id/settings → per-bank sync window override (null = app default)
 *   GET    /sync-status    → per-connection sync state (+ scheduler health)
 *   POST   /:id/sync       → enqueue a background sync (returns the run; /reimport likewise)
 *   DELETE /:id            → disconnect upstream (idempotent) + flip local row
 *
 * Aggregators are resolved per provider through ./registry — the
 * route never imports an adapter. The inbound webhook lives in
 * ./webhook — mounted before the auth gate
 * because providers call it machine-to-machine.
 */
import { Hono } from 'hono';
import { z } from '@shared/zod';

import { getAggregator, hasProvider } from './registry';
import { getSyncWindowDays, setSyncWindowDays } from './settings';
import { withPostConnectSettle } from './settle';
import * as store from './store';
import type { ConnectionWithLinker } from './store';
import { deriveSyncState } from './domain/sync-state';
import { enqueueConnectionSync } from './job';
import { CONNECTIONS_SYNC_JOB, syncSubjectKey, type SyncMode } from './jobspec';
import { runsForSubjects, schedulerHealth, type JobRun } from '../jobs';
import type { ExternalAccount } from './types';
import { requireUserId } from '../user';
import { pool } from '../core/db';
import { implement } from '../core/operation';
import { HttpError } from '../core/validate';
import * as contracts from '@shared/contracts/connections/connections';
import { connectionsRouter } from './router';

/**
 * Aggregator resolution with HTTP semantics: an unknown provider → 404, a
 * registered one with missing credentials → 503 (fail loud — a silent null
 * would masquerade as an empty account list).
 */
function aggregatorFor(provider: string) {
  if (!hasProvider(provider)) throw new HttpError(404, `unknown connections provider ${provider}`);
  const aggregator = getAggregator(provider);
  if (!aggregator) throw new HttpError(503, `connections provider ${provider} is not configured`);
  return aggregator;
}

/**
 * Provider-API failures surface as 502. The provider's own message is kept —
 * "Pluggy API 404: item is processing" is the difference between a support
 * ticket and a self-service fix — but it is bounded and sanitized so driver
 * internals (stacks, wire dumps) never leak.
 */
export const PROVIDER_UNREADABLE =
  "Couldn't sync with the bank — the provider returned data we couldn't read. We'll retry on the next sync.";

function throwProviderMapped(err: unknown): never {
  if (err instanceof HttpError) throw err;
  if (err instanceof z.ZodError) {
    // Provider payload didn't match our schema: keep the raw issues in the
    // server log only, return a short human message.
    console.error('connections: provider response failed validation', JSON.stringify(err.issues));
    throw new HttpError(502, PROVIDER_UNREADABLE);
  }
  const detail =
    err instanceof Error
      ? err.message.replaceAll(/[\r\n\t]+/g, ' ').replaceAll(/\s+/g, ' ').trim().slice(0, 200)
      : '';
  throw new HttpError(502, detail ? `provider request failed: ${detail}` : 'provider request failed');
}

const connectionJson = (row: ConnectionWithLinker) => ({
  id: row.id,
  provider: row.provider,
  external_id: row.external_id,
  client_user_id: row.client_user_id,
  status: row.status,
  /** Sanitized user-facing reason for a non-connected status. */
  status_message: row.status_message,
  environment: row.environment,
  institution: row.institution,
  last_synced_at: row.last_synced_at,
  sync_window_days: row.sync_window_days,
  /** Who linked the bank (their name/email/avatar). */
  linked_by: row.linked_by,
  created_at: row.created_at,
  updated_at: row.updated_at,
});

const app = new Hono();

/**
 * Operations. Order matters — the static /connect-token, /settings, /upstream
 * and /sync-status routes are registered before /:id so Hono never shadows them.
 */
export const operations = [
  /** Mint a connect token for the provider's widget. */
  implement(contracts.connectionsConnectToken, async (c, body) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    const aggregator = aggregatorFor(body.provider);
    try {
      const token = await aggregator.createConnectToken({
        clientUserId: user.id,
        connectorId: body.connectorId,
        itemId: body.itemId,
      });
      return { token: token.token, clientId: token.clientId, widgetUrl: token.widgetUrl };
    } catch (err) {
      throwProviderMapped(err);
    }
  }),

  /**
   * Register a connected item after widget success: persist the local row and
   * discover its upstream accounts. No accounts are persisted here — the link
   * is created on a budget account via PATCH /accounts/:id using one of the
   * returned candidates. Idempotent per (provider, upstream item); another
   * user's item → 409.
   */
  implement(contracts.connectionsItemsRegister, async (c, body) => {
    const user = c.get('user');
    if (!user) throw new HttpError(401, 'unauthorized');
    const aggregator = aggregatorFor(body.provider);
    try {
      // Claim first: another user's upstream item is a 409 before any upstream
      // call, so registration never leaks a foreign item's accounts.
      const row = await store.upsertConnection({
        userId: user.id,
        provider: body.provider,
        externalId: body.itemId,
        clientUserId: user.id,
        status: 'connected',
        environment: aggregator.environment,
      });
      const accounts = await withPostConnectSettle(() => aggregator.listExternalAccounts(body.itemId));
      // Item-level connector name first (the real bank identity); account-level
      // institution is the fallback for providers that only label accounts.
      const institution =
        (await aggregator.fetchInstitution(body.itemId).catch(() => null)) ??
        accounts.find((account) => account.institution != null)?.institution ??
        null;
      const updated = institution == null ? row : await store.setConnectionInstitution(row.id, institution);
      return { connection: connectionJson(await store.withLinkedBy(updated)), accounts };
    } catch (err) {
      throwProviderMapped(err);
    }
  }),

  /** List the user's connections with their statuses (drives the re-auth CTA). */
  implement(contracts.connectionsList, async (c) => {
    const userId = requireUserId(c);
    const rows = await store.listConnectionsByUser(userId);
    return rows.map(connectionJson);
  }),

  /**
   * Sync-window configuration (app-global, not per user): how far back pulls
   * reach. 0 = All history (no lower bound); 1..3650 caps every pull at N days.
   */
  implement(contracts.connectionsSettingsGet, async (c) => {
    requireUserId(c);
    return { syncWindowDays: await getSyncWindowDays() };
  }),

  implement(contracts.connectionsSettingsUpdate, async (c, { syncWindowDays }) => {
    requireUserId(c);
    return { syncWindowDays: await setSyncWindowDays(syncWindowDays) };
  }),

  /**
   * Every upstream account across the user's live connections, annotated with
   * the budget account currently linked to it (strict 1:1 — at most one).
   * Feeds the in-modal bank-link chooser; a provider failure degrades that one
   * connection's list to null so the UI can show its re-auth state instead of
   * silently dropping the bank.
   */
  implement(contracts.connectionsUpstream, async (c) => {
    const userId = requireUserId(c);
    const rows = (await store.listConnectionsByUser(userId)).filter((row) => row.status !== 'disconnected');
    const linked = await pool.query<{ connection_id: string; external_account_id: string; account_id: string }>(
      `SELECT connection_id, external_account_id, id AS account_id
         FROM public.accounts
        WHERE connection_id = ANY($1::uuid[]) AND connection_id IS NOT NULL
          AND external_account_id IS NOT NULL AND NOT deleted`,
      [rows.map((row) => row.id)],
    );
    const linkedByPair = new Map(
      linked.rows.map((r) => [`${r.connection_id}:${r.external_account_id}`, r.account_id]),
    );
    return Promise.all(
      rows.map(async (row) => {
        const aggregator = aggregatorFor(row.provider);
        let accounts: (ExternalAccount & { linkedAccountId: string | null })[] | null;
        try {
          const external = await aggregator.listExternalAccounts(row.external_id);
          accounts = external.map((acct) => ({
            ...acct,
            linkedAccountId: linkedByPair.get(`${row.id}:${acct.externalId}`) ?? null,
          }));
        } catch (err) {
          // One broken bank must not blank the whole chooser — degrade to a
          // null list; the client renders that connection's re-auth state.
          if (err instanceof HttpError) throw err;
          accounts = null;
        }
        return { connection: connectionJson(row), accounts };
      }),
    );
  }),

  /** Per-bank sync window (null clears the override → inherits the app-wide default). */
  implement(contracts.connectionsSettingsUpdateOne, async (c, { id, syncWindowDays }) => {
    const userId = requireUserId(c);
    const row = await store.getConnectionByUser(userId, id);
    if (!row) throw new HttpError(404, 'not found');
    return connectionJson(await store.withLinkedBy(await store.setConnectionSyncWindow(row.id, syncWindowDays)));
  }),

  /** Per-connection sync state: status, active/last run, scheduler health. */
  implement(contracts.connectionsSyncStatus, async (c) => syncStatus(requireUserId(c))),

  /** One connection's status — cross-user ids surface as 404. */
  implement(contracts.connectionsGet, async (c, { id }) => {
    const userId = requireUserId(c);
    const row = await store.getConnectionByUser(userId, id);
    if (!row) throw new HttpError(404, 'not found');
    return connectionJson(row);
  }),

  /** Per-account import counts + connection totals (DB only; bank-side names come from /upstream). */
  implement(contracts.connectionsSummary, async (c, { id }) => {
    const userId = requireUserId(c);
    const row = await store.getConnectionByUser(userId, id);
    if (!row) throw new HttpError(404, 'not found');
    return connectionSummary(row.id);
  }),

  /** One linked account's imported transactions, keyset-paginated (date DESC, id DESC). */
  implement(contracts.connectionsTransactions, async (c, { id, accountId, cursor, limit }) => {
    const userId = requireUserId(c);
    const row = await store.getConnectionByUser(userId, id);
    if (!row) throw new HttpError(404, 'not found');
    return connectionTransactionsPage(row.id, accountId, cursor, limit);
  }),

  /** Request a background sync (coalesced with any in-flight one). */
  implement(contracts.connectionsSync, async (c, { id }) => requestSync(requireUserId(c), id, 'sync')),

  /**
   * Re-import history: one pull that ignores the watermark and reaches the full
   * window (All = unbounded). Deduped by import-id, so repeating it is safe —
   * it back-fills accounts that were linked after their connection first synced.
   */
  implement(contracts.connectionsReimport, async (c, { id }) => requestSync(requireUserId(c), id, 'reimport')),

  /**
   * Disconnect: remove the item upstream (tolerating already-gone) and flip
   * the local row out of the poller's reach. Ledger rows and history persist.
   * Blocked while any budget account still links to the connection — removal
   * is deliberate upstream deletion, not a link edit; the account editor
   * unlinks per account first.
   */
  implement(contracts.connectionsDelete, async (c, { id }) => {
    const userId = requireUserId(c);
    const row = await store.getConnectionByUser(userId, id);
    if (!row) throw new HttpError(404, 'not found');
    const linked = await pool.query<{ name: string }>(
      `SELECT name FROM public.accounts
       WHERE connection_id = $1 AND NOT deleted`,
      [row.id],
    );
    if (linked.rows.length > 0) {
      throw new HttpError(
        409,
        `still linked to ${linked.rows.map((r) => r.name).join(', ')} — unlink in the account editor first`,
      );
    }
    const aggregator = aggregatorFor(row.provider);
    try {
      await aggregator.deleteConnection(row.external_id);
    } catch (err) {
      // Upstream already gone (or the user deleted it in the provider's
      // dashboard) → the local disconnect still proceeds.
      if (err instanceof HttpError) throw err;
    }
    await store.markDisconnected(row.id);
    return { ok: true };
  }),
];

type TxnState = 'imported' | 'edited' | 'removed';

/** Opaque keyset cursor: `<date>_<transaction uuid>`, base64url. */
const encodeCursor = (date: string, id: string) => Buffer.from(`${date}_${id}`).toString('base64url');
function decodeCursor(cursor: string): { date: string; id: string } {
  const m = /^(\d{4}-\d{2}-\d{2})_([0-9a-f-]{36})$/i.exec(Buffer.from(cursor, 'base64url').toString());
  if (!m || Number.isNaN(Date.parse(m[1]!))) throw new HttpError(400, 'invalid cursor');
  return { date: m[1]!, id: m[2]! };
}

/** removed = deleted (tombstoned) row; edited = live row the user changed (blocked); else imported. */
const STATE_SQL = `CASE WHEN t.deleted THEN 'removed' WHEN s.blocked THEN 'edited' ELSE 'imported' END`;

async function connectionSummary(connectionId: string) {
  const { rows } = await pool.query<{
    account_id: string;
    name: string;
    type: string;
    external_account_id: string | null;
    balance: string | number;
    imported: string;
    edited: string;
    removed: string;
    first_date: string | null;
    last_date: string | null;
  }>(
    `SELECT a.id AS account_id, a.name, a.type, a.external_account_id,
            (a.cleared_balance + a.uncleared_balance) AS balance,
            count(*) FILTER (WHERE ${STATE_SQL} = 'imported') AS imported,
            count(*) FILTER (WHERE ${STATE_SQL} = 'edited') AS edited,
            count(*) FILTER (WHERE ${STATE_SQL} = 'removed') AS removed,
            min(t.date) FILTER (WHERE NOT t.deleted)::text AS first_date,
            max(t.date) FILTER (WHERE NOT t.deleted)::text AS last_date
       FROM public.accounts a
       LEFT JOIN public.transactions t ON t.account_id = a.id
       LEFT JOIN public.connection_transactions s ON s.transaction_id = t.id
      WHERE a.connection_id = $1 AND NOT a.deleted
        AND (t.id IS NULL OR s.transaction_id IS NOT NULL)
      GROUP BY a.id
      ORDER BY a.name, a.id`,
    [connectionId],
  );
  const accounts = rows.map((r) => {
    const importedCount = Number(r.imported);
    const editedCount = Number(r.edited);
    const removedCount = Number(r.removed);
    return {
      accountId: r.account_id,
      name: r.name,
      type: r.type,
      externalAccountId: r.external_account_id,
      balance: Number(r.balance),
      importedCount,
      editedCount,
      removedCount,
      totalCount: importedCount + editedCount + removedCount,
      firstDate: r.first_date,
      lastDate: r.last_date,
    };
  });
  const sum = (key: 'importedCount' | 'editedCount' | 'removedCount' | 'totalCount') =>
    accounts.reduce((n, a) => n + a[key], 0);
  return {
    connectionId,
    accounts,
    totals: {
      importedCount: sum('importedCount'),
      editedCount: sum('editedCount'),
      removedCount: sum('removedCount'),
      totalCount: sum('totalCount'),
    },
  };
}

async function connectionTransactionsPage(
  connectionId: string,
  accountId: string,
  cursor: string | undefined,
  limit: number,
) {
  const owned = await pool.query(
    'SELECT 1 FROM public.accounts WHERE id = $1 AND connection_id = $2 AND NOT deleted',
    [accountId, connectionId],
  );
  if (owned.rows.length === 0) throw new HttpError(404, 'not found');
  const after = cursor ? decodeCursor(cursor) : null;
  const { rows } = await pool.query<{
    id: string;
    date: string;
    amount: string | number;
    payee: string | null;
    memo: string | null;
    cleared: 'cleared' | 'uncleared' | 'reconciled';
    state: TxnState;
  }>(
    `SELECT t.id, t.date::text AS date, t.amount, COALESCE(p.name, t.import_payee_name) AS payee,
            t.memo, t.cleared, ${STATE_SQL} AS state
       FROM public.transactions t
       JOIN public.connection_transactions s ON s.transaction_id = t.id
       LEFT JOIN public.payees p ON p.id = t.payee_id
      WHERE t.account_id = $1
        AND ($2::date IS NULL OR (t.date, t.id) < ($2::date, $3::uuid))
      ORDER BY t.date DESC, t.id DESC
      LIMIT $4`,
    [accountId, after?.date ?? null, after?.id ?? null, limit + 1],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({ ...r, amount: Number(r.amount) })),
    nextCursor: rows.length > limit && last ? encodeCursor(last.date, last.id) : null,
  };
}

const runJson = (run: JobRun) => ({
  id: run.id,
  status: run.status,
  mode: ((run.input as { mode?: SyncMode } | null)?.mode ?? 'sync') as SyncMode,
  created_at: run.created_at,
  finished_at: run.finished_at,
  user_message: run.user_message,
  /** Sync counts (added/updated/deleted/…) on success; user-safe by construction. */
  result: run.result ?? null,
});

/**
 * Shared by sync and reimport: ownership check, then enqueue (or join) the
 * background job — the HTTP call never touches the provider. They differ only
 * in the subject key (see jobspec.ts) and the watermark the job uses.
 */
async function requestSync(userId: string, id: string, mode: SyncMode) {
  const row = await store.getConnectionByUser(userId, id);
  if (!row) throw new HttpError(404, 'not found');
  if (row.status === 'disconnected') throw new HttpError(409, 'connection is disconnected');
  aggregatorFor(row.provider); // fail fast (404/503) when the provider is unknown/unconfigured
  const { run, created } = await enqueueConnectionSync(pool, row, mode, `user:${userId}`);
  return { connection: connectionJson(row), run: runJson(run), created };
}

async function syncStatus(userId: string) {
  const rows = await store.listConnectionsByUser(userId);
  const keys = rows.flatMap((r) => [syncSubjectKey(r.id, 'sync'), syncSubjectKey(r.id, 'reimport')]);
  const [{ active, lastFinished }, health] = await Promise.all([
    runsForSubjects(pool, CONNECTIONS_SYNC_JOB, keys),
    schedulerHealth(),
  ]);
  const schedulerDegraded = !health.up;
  const connections = rows.map((row) => {
    const mine = (r: JobRun) => r.subject_key === row.id || r.subject_key === `${row.id}:reimport`;
    // Running beats queued; newest first within a status.
    const activeRun = active.filter(mine).sort((a, b) => (a.status === b.status ? 0 : a.status === 'running' ? -1 : 1))[0] ?? null;
    const lastRun =
      lastFinished.filter(mine).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))[0] ?? null;
    return {
      id: row.id,
      institution: row.institution,
      status: row.status,
      status_message: row.status_message,
      last_synced_at: row.last_synced_at,
      state: deriveSyncState({
        status: row.status,
        activeRun: activeRun ? (activeRun.status as 'queued' | 'running') : null,
        schedulerDegraded,
      }),
      active_run: activeRun ? runJson(activeRun) : null,
      last_run: lastRun ? runJson(lastRun) : null,
    };
  });
  return {
    scheduler_degraded: schedulerDegraded,
    ...(schedulerDegraded ? { scheduler_reason: 'Background sync is offline; syncs will run when it recovers.' } : {}),
    connections,
  };
}

connectionsRouter(app, operations);

export default app;
