/**
 * Connections→budget transaction sync engine (v1.1 Phase 4).
 *
 * Pulls transactions for every budget account linked to one connection
 (`accounts.connection_id` + `external_account_id`), stores the
 * adapters' signed milliunit amounts as they are (each adapter converts its
 * provider's unit once, at its own boundary), and
 * persists them through the budget `transactions` table with an import ledger
 * in `connection_transactions` (`import_id` = `<provider>:<external txn id>`,
 * idempotent across re-pulls).
 *
 * Engine-owned rows (date/amount/memo/payee) are compared against the stored
 * payload: untouched rows follow upstream edits, user-modified rows are
 * blocked and left authoritative, upstream-deleted rows are tombstoned unless
 * blocked. All writes of one account batch commit in a single server-side
 * transaction, so a partial failure cannot leave balance caches half-moved.
 *
 * Every write into budget's tables (payees, imported rows, refreshes,
 * tombstones, balance deltas, card-payment pairing) goes through budget's
 * `ledger` API (src/budget/ledger.ts, via the budget barrel). The shadow
 * table `connection_transactions` is this feature's own.
 */

import { pool } from '../core/db';
import { ledger } from '../budget';
import { HttpError } from '../core/validate';
import { getConnectionByUser, setConnectionInstitution, withLinkedBy, type ConnectionRow, type ConnectionWithLinker } from './store';
import { ALL_HISTORY_DAYS, effectiveSyncWindowDays, getSyncWindowDays } from './settings';
import type { AggregatedTransaction, BankAggregator } from './types';

/** Counts reported to the caller. */
export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
  /** Rows skipped because they were user-modified or not engine-owned. */
  blocked: number;
  /** Engine-owned rows already matching upstream — the idempotent no-ops. */
  duplicates: number;
}

/** Fields the sync engine owns, in the stored-payload compare shape. */
interface OwnedPayload {
  date: string;
  /** Signed milliunits. */
  amount: number;
  memo: string;
  payee: string;
}

interface LinkedAccountRow {
  /** The budget account id (accounts row is the link itself). */
  id: string;
  budget_id: string;
  external_account_id: string;
}

interface ExistingTxnRow {
  id: string;
  date: string;
  /** Signed milliunits (bigint → string). */
  amount: number;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  payee_name: string | null;
  shadow_blocked: boolean | null;
  shadow_payload: OwnedPayload | null;
}

const today = (): string => new Date().toISOString().slice(0, 10);

const isoDaysAgo = (days: number): string =>
  new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

/**
 * Lower bound of a pull, in ISO date order. The configured window caps every
 * pull (lookback), not just the first one; All history (0) adds no floor.
 * The watermark overlaps by one day so same-day upstream edits are re-checked.
 */
export function pullFrom(watermark: Date | null, windowDays: number): string | null {
  const overlap =
    watermark == null
      ? null
      : new Date(watermark.getTime() - 86_400_000).toISOString().slice(0, 10);
  if (windowDays === ALL_HISTORY_DAYS) return overlap;
  const floor = isoDaysAgo(windowDays);
  if (overlap == null) return floor;
  return overlap > floor ? overlap : floor;
}

const payloadFromRow = (row: { date: string; amount: number; memo: string | null; payee_name: string | null }): OwnedPayload => ({
  date: row.date,
  amount: Number(row.amount),
  memo: row.memo ?? '',
  payee: row.payee_name ?? '',
});

const samePayload = (a: OwnedPayload, b: OwnedPayload): boolean =>
  a.date === b.date && a.amount === b.amount && a.memo === b.memo && a.payee === b.payee;

/**
 * Per-account balance delta accumulators, in MILLIUNITS (the adapters already
 * hand amounts over in milliunits), bucketed by the row's current cleared
 * state so refreshed amounts move the right cached balance.
 */
interface AccountDeltas {
  cleared_delta: number;
  uncleared_delta: number;
}

/** Upper bound for one account's whole upstream pull (all pages). */
export const UPSTREAM_TIMEOUT_MS = 90_000;
/** Re-snapshot attempts when another sync commits between our fetch and our write. */
const MAX_RACE_ATTEMPTS = 3;

/** Reject when `promise` has not settled within `ms` (the pull itself is abandoned, not aborted). */
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, `${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Per-connection in-process single-flight: syncs of one connection run one after another. */
const tails = new Map<string, Promise<unknown>>();
async function serialized<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    if (tails.get(key) === tail) tails.delete(key);
  }
}

interface FetchedAccount {
  acc: LinkedAccountRow;
  transactions: AggregatedTransaction[];
  /** True only when upstream reported the requested window fully paginated. */
  complete: boolean;
}

/**
 * Sync all linked budget accounts of one connection.
 *
 * Phase 1 (no transaction, no lock): snapshot the watermark and linked
 * accounts, then pull every account from upstream — each pull bounded by a
 * timeout, so a slow bank can only delay this sync, never pin a pooled
 * client or a row lock.
 * Phase 2 (one short server-side transaction): lock the connection row
 * (`FOR UPDATE` serializes concurrent syncs of the same connection exactly as
 * before), verify the watermark is unchanged since the snapshot — if another
 * sync committed meanwhile our fetched data may be stale, so we roll back and
 * start over from a fresh snapshot — then write inserts, refreshes, sweeps
 * and balance moves together.
 */
export async function syncConnectionTransactions(input: {
  userId: string;
  connectionId: string;
  aggregator: BankAggregator;
  /** Re-import: ignore the watermark so the pull reaches the full window. */
  ignoreWatermark?: boolean;
  /** Per-account upstream pull timeout (test seam; defaults to UPSTREAM_TIMEOUT_MS). */
  upstreamTimeoutMs?: number;
  /** Called between accounts (job heartbeat). */
  onProgress?: () => void;
  /**
   * Cancellation point: runs before phase 2 opens its transaction and again
   * right before COMMIT. Throwing aborts (and rolls back) the whole sync, so a
   * cancelled run is all-or-nothing.
   */
  beforeCommit?: () => void | Promise<void>;
}): Promise<SyncResult> {
  const { userId, connectionId } = input;

  const row = await getConnectionByUser(userId, connectionId);
  if (!row) throw new HttpError(404, 'connection not found');

  return serialized(row.id, async () => {
    for (let attempt = 1; attempt <= MAX_RACE_ATTEMPTS; attempt++) {
      const result = await syncOnce(input, row);
      if (result) return result;
    }
    throw new HttpError(409, 'connection sync raced with another sync; retry');
  });
}

/** One fetch-then-write pass; null when the watermark moved under us (caller retries). */
async function syncOnce(
  input: Parameters<typeof syncConnectionTransactions>[0],
  row: ConnectionRow,
): Promise<SyncResult | null> {
  const { aggregator } = input;

  // ---- Phase 1: snapshot + upstream pulls, no transaction open ----------
  const snapshot = await pool.query<{ last_synced_at: Date | null }>(
    'SELECT last_synced_at FROM public.connections WHERE id = $1',
    [row.id],
  );
  const snapshotAt = snapshot.rows[0]?.last_synced_at ?? null;
  const from = pullFrom(
    input.ignoreWatermark ? null : snapshotAt,
    effectiveSyncWindowDays(row.sync_window_days, await getSyncWindowDays()),
  );
  // The tombstone sweep compares dates in SQL — All history is expressed
  // there as an arbitrarily old floor rather than a NULL bound.
  const sweepFrom = from ?? '0001-01-01';
  const to = today();

  // Budget accounts linked to upstream accounts of this connection:
  // unlinked accounts are skipped — mirroring is a budget-module concern.
  const linkedSql = `SELECT ac.id, ac.budget_id, ac.external_account_id
         FROM public.accounts ac
         JOIN public.connections c ON c.id = ac.connection_id
         WHERE ac.connection_id = $1 AND ac.external_account_id IS NOT NULL
           AND ac.deleted = false`;
  const linked = (await pool.query<LinkedAccountRow>(linkedSql, [row.id])).rows;

  const timeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const fetched = new Map<string, FetchedAccount>();
  for (const acc of linked) {
    const upstream = await withTimeout(
      aggregator.listTransactions(acc.external_account_id, {
        ...(from != null ? { from } : {}),
        to,
      }),
      timeoutMs,
      `upstream listTransactions(${acc.external_account_id})`,
    );
    fetched.set(acc.id, { acc, transactions: upstream.transactions, complete: !upstream.hasMore });
    input.onProgress?.();
  }
  await input.beforeCommit?.();

  // ---- Phase 2: short write transaction ---------------------------------
  const pg = await pool.connect();
  try {
    await pg.query('BEGIN');

    const result: SyncResult = { added: 0, updated: 0, deleted: 0, blocked: 0, duplicates: 0 };

    // Lock the connection row so concurrent syncs cannot double-write, then
    // re-check: if another sync committed since our snapshot, our upstream
    // data is stale (its sweep could tombstone rows the other sync added).
    const locked = await pg.query<{ last_synced_at: Date | null }>(
      'SELECT last_synced_at FROM public.connections WHERE id = $1 FOR UPDATE',
      [row.id],
    );
    if ((locked.rows[0]?.last_synced_at?.getTime() ?? null) !== (snapshotAt?.getTime() ?? null)) {
      await pg.query('ROLLBACK');
      return null;
    }

    // Only accounts we actually pulled (links may have changed meanwhile).
    const stillLinked = (await pg.query<LinkedAccountRow>(linkedSql, [row.id])).rows;

    for (const { id } of stillLinked) {
      const pulled = fetched.get(id);
      if (!pulled) continue;
      const { acc } = pulled;
      const upstream = { transactions: pulled.transactions };
      const seen = new Set(upstream.transactions.map((txn) => txn.externalId));

      input.onProgress?.();
      // Budget's ledger API: rename rules + create-or-find, cached per batch.
      const resolver = ledger.createImportPayeeResolver(pg, acc.budget_id);
      const deltas: AccountDeltas = { cleared_delta: 0, uncleared_delta: 0 };

      for (const txn of upstream.transactions) {
        const milli = txn.amount;
        const importId = `${row.provider}:${txn.externalId}`;
        const existing = (
          await pg.query<ExistingTxnRow>(
            `SELECT t.id, t.date::text AS date, t.amount, t.memo, t.cleared,
                    p.name AS payee_name,
                    s.blocked AS shadow_blocked, s.last_synced_payload AS shadow_payload
             FROM public.transactions t
             LEFT JOIN public.connection_transactions s ON s.transaction_id = t.id
             LEFT JOIN public.payees p ON p.id = t.payee_id
             WHERE t.account_id = $1 AND t.import_id = $2 AND NOT t.deleted`,
            [acc.id, importId],
          )
        ).rows[0];

        if (!existing) {
          // Fresh import — bank-confirmed rows land cleared (the user-visible
          // "synced" semantic); unapproved, uncategorized (the review flow
          // owns categorization). The shadow stores the date-only form the
          // read-back path (`t.date::text`) compares against — a raw upstream
          // timestamp would mismatch itself on the very next pull.
          const cleared = txn.cleared ? 'cleared' : 'uncleared';
          const payee = await resolver.resolve(txn.description);
          const insertedId = await ledger.insertImportedTransaction(pg, {
            budgetId: acc.budget_id,
            accountId: acc.id,
            date: txn.date.slice(0, 10),
            amount: milli,
            payeeId: payee.id,
            importId,
            importPayeeName: payee.name || null,
            cleared,
          });
          await pg.query(
            `INSERT INTO connection_transactions
               (transaction_id, provider, external_transaction_id, last_synced_payload, blocked)
             VALUES ($1, $2, $3, $4, false)`,
            [
              insertedId,
              row.provider,
              txn.externalId,
              JSON.stringify({ date: txn.date.slice(0, 10), amount: milli, memo: '', payee: payee.name }),
            ],
          );
          result.added += 1;
          deltas[cleared === 'cleared' ? 'cleared_delta' : 'uncleared_delta'] += milli;
          continue;
        }

        if (existing.shadow_blocked || existing.shadow_payload == null) {
          // User-modified engine rows stay frozen; rows without a shadow
          // record (e.g. statement import sharing the import id) were never
          // engine-owned — never touch either kind.
          result.blocked += 1;
          continue;
        }

        const current = payloadFromRow(existing);
        if (!samePayload(current, existing.shadow_payload)) {
          await pg.query(
            'UPDATE connection_transactions SET blocked = true, updated_at = now() WHERE transaction_id = $1',
            [existing.id],
          );
          result.blocked += 1;
          continue;
        }

        const upstreamPayee = await resolver.resolve(txn.description);
        // The ledger's read-back form is date-only (`t.date::text`); compare
        // like with like so unchanged upstream rows stay duplicates.
        const upstreamPayload: OwnedPayload = {
          date: txn.date.slice(0, 10),
          amount: milli,
          memo: '',
          payee: upstreamPayee.name,
        };
        if (samePayload(current, upstreamPayload)) {
          result.duplicates += 1;
          continue;
        }

        // Upstream changed a row the user left untouched → refresh the owned
        // fields; cleared/approved state is preserved.
        await ledger.refreshImportedTransaction(pg, existing.id, {
          date: txn.date.slice(0, 10),
          amount: milli,
          payeeId: upstreamPayee.id,
          importPayeeName: upstreamPayee.name || null,
        });
        await pg.query(
          `UPDATE connection_transactions
           SET last_synced_payload = $2, updated_at = now()
           WHERE transaction_id = $1`,
          [existing.id, JSON.stringify(upstreamPayload)],
        );
        result.updated += 1;
        const bucket = existing.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
        deltas[bucket] += milli - Number(existing.amount);
      }

      // Missing-upstream deletes: engine-owned, unblocked rows within the
      // pulled window that no longer exist upstream are tombstoned. Blocked
      // rows are kept whatever upstream does.
      //
      // "Missing from the response" only means "deleted upstream" when the
      // response provably covered the whole window [sweepFrom, to]. The
      // adapter reports `hasMore` for any truncated pull (page/result cap);
      // then we skip the sweep for this account this run. A complete pull
      // with zero rows is a genuinely empty window and does sweep. Rows
      // outside [sweepFrom, to] (older, or future-dated) are never swept, and
      // reconciled rows are never tombstoned.
      if (!pulled.complete) {
        console.warn(
          `Connections sync: upstream pull for account ${acc.external_account_id} was incomplete (hasMore); skipping tombstone sweep this run`,
        );
      }
      const tracked = pulled.complete ? (
        await pg.query<{ id: string; amount: number; cleared: ExistingTxnRow['cleared']; external_transaction_id: string }>(
          `SELECT t.id, t.amount, t.cleared, s.external_transaction_id
           FROM public.transactions t
           JOIN public.connection_transactions s ON s.transaction_id = t.id
           WHERE t.account_id = $1 AND NOT t.deleted AND NOT s.blocked
             AND t.cleared <> 'reconciled' AND t.date >= $2 AND t.date <= $3`,
          [acc.id, sweepFrom, to],
        )
      ).rows : [];
      for (const trackedRow of tracked) {
        if (seen.has(trackedRow.external_transaction_id)) continue;
        await ledger.tombstoneTransaction(pg, trackedRow.id);
        const bucket = trackedRow.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
        deltas[bucket] -= Number(trackedRow.amount);
        result.deleted += 1;
      }

      if (deltas.cleared_delta !== 0 || deltas.uncleared_delta !== 0) {
        await ledger.applyBalanceDeltas(pg, acc.budget_id, [
          {
            account_id: acc.id,
            cleared_delta: deltas.cleared_delta,
            uncleared_delta: deltas.uncleared_delta,
          },
        ]);
      }
    }

    // Pair imported card-statement payments (cash outflow + card inflow) as
    // transfers; idempotent, so it also backfills rows imported earlier.
    for (const budgetId of new Set(stillLinked.filter((a) => fetched.has(a.id)).map((a) => a.budget_id))) {
      await ledger.linkCardPayments(pg, budgetId);
    }

    await pg.query(
      'UPDATE public.connections SET last_synced_at = now(), updated_at = now() WHERE id = $1',
      [row.id],
    );

    await input.beforeCommit?.();
    await pg.query('COMMIT');
    return result;
  } catch (err) {
    await pg.query('ROLLBACK');
    throw err;
  } finally {
    pg.release();
  }
}

/**
 * Full connection refresh, run by the `connections_sync` job (manual sync,
 * webhooks and the 6h sweep all enqueue it): pull new transactions through the
 * engine and stamp the watermark. Item/connection status is owned by the job
 * (see activities.ts) and webhook events, not by this function.
 */
export async function refreshConnection(input: {
  userId: string;
  connectionId: string;
  aggregator: BankAggregator;
  /** Re-import: ignore the watermark so the pull reaches the full window. */
  ignoreWatermark?: boolean;
  onProgress?: () => void;
  beforeCommit?: () => void | Promise<void>;
}): Promise<{ row: ConnectionWithLinker; transactions: SyncResult }> {
  const { userId, connectionId, aggregator } = input;
  const row = await getConnectionByUser(userId, connectionId);
  if (!row) throw new HttpError(404, 'connection not found');
  const transactions = await syncConnectionTransactions({
    userId,
    connectionId: row.id,
    aggregator,
    ...(input.ignoreWatermark !== undefined ? { ignoreWatermark: input.ignoreWatermark } : {}),
    ...(input.onProgress ? { onProgress: input.onProgress } : {}),
    ...(input.beforeCommit ? { beforeCommit: input.beforeCommit } : {}),
  });
  let updated = await getConnectionByUser(userId, row.id);
  // Backfill the bank's display name on every sync: rows registered before
  // name capture existed (or whose provider reported none at connect time)
  // rename on their next successful sync — the provider's connector name is
  // the identity, not the generic provider key.
  if (updated && updated.institution == null) {
    const institution = await aggregator.fetchInstitution(row.external_id).catch(() => null);
    if (institution) updated = await withLinkedBy(await setConnectionInstitution(row.id, institution));
  }
  return { row: updated ?? row, transactions };
}
