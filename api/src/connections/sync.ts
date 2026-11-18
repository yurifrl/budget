/**
 * Connections→budget transaction sync engine (v1.1 Phase 4).
 *
 * Pulls transactions for every budget account linked to one connection
 (`accounts.connection_id` + `external_account_id`), converts upstream signed
 * cent amounts into the storage boundary's signed-milliunit shape
 * (cents × 10 — the same conversion `store.centsFrom` uses for balances), and
 * persists them through the budget `transactions` table with an import ledger
 * in `connection_transactions` (`import_id` = `<provider>:<external txn id>`,
 * idempotent across re-pulls).
 *
 * Engine-owned rows (date/amount/memo/payee) are compared against the stored
 * payload: untouched rows follow upstream edits, user-modified rows are
 * blocked and left authoritative, upstream-deleted rows are tombstoned unless
 * blocked. All writes of one account batch commit in a single server-side
 * transaction, so a partial failure cannot leave balance caches half-moved.
 */

import type { PoolClient } from 'pg';

import type { RenameRule } from '@shared/domain/payees';
import { applyRules } from '@shared/domain/payees';
import { pool } from '../core/db';
import { applyBalanceDeltas } from '../budget/domain/transactions';
import { linkCardPayments } from '../budget';
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

/** Upstream cents → storage milliunits (×10, the boundary conversion). */
const milliFromUpstream = (cents: number): number => Math.round(cents) * 10;

/**
 * Rule-rewritten payee resolution for one budget, cached per raw name.
 * A sync batch repeats payees heavily; rules are read once. Mirrors
 * `resolvePayeeId` in budget/domain/transactions (create-or-find, rule-rewritten
 * name is the stored name, empty effective names stay null).
 */
class PayeeResolver {
  private readonly cache = new Map<string, { id: string | null; name: string }>();

  constructor(
    private readonly client: PoolClient,
    private readonly budgetId: string,
  ) {}

  private rules: RenameRule[] | null = null;

  async resolve(rawName: string): Promise<{ id: string | null; name: string }> {
    const name = rawName.trim();
    if (!name) return { id: null, name: '' };
    if (!this.cache.has(name)) {
      if (!this.rules) {
        const found = await this.client.query<RenameRule>(
          `SELECT name as replacement, rename_match_type as match_type, rename_condition as condition
           FROM payees WHERE budget_id = $1 AND deleted = false AND rename_condition IS NOT NULL
           ORDER BY created_at`,
          [this.budgetId],
        );
        this.rules = found.rows;
      }
      const effective = applyRules(this.rules, name);
      if (!effective.trim()) {
        this.cache.set(name, { id: null, name: '' });
      } else {
        const result = await this.client.query<{ id: string }>(
          `INSERT INTO payees (budget_id, name)
           VALUES ($1, $2)
           ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
           RETURNING id`,
          [this.budgetId, effective],
        );
        this.cache.set(name, { id: result.rows[0].id, name: effective });
      }
    }
    return this.cache.get(name)!;
  }
}

/**
 * Per-account balance delta accumulators, in CENTS, bucketed by the row's
 * current cleared state so refreshed amounts move the right cached balance
 * (applyBalanceDeltas multiplies by 10 — deltas are its input unit).
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
      const resolver = new PayeeResolver(pg, acc.budget_id);
      const deltas: AccountDeltas = { cleared_delta: 0, uncleared_delta: 0 };

      for (const txn of upstream.transactions) {
        const milli = milliFromUpstream(txn.amountCents);
        const cents = milli / 10;
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
          const inserted = await pg.query<{ id: string }>(
            `INSERT INTO transactions
               (budget_id, account_id, date, amount, payee_id, category_id, memo,
                cleared, approved, flag_color, flag_name, repeat, deleted,
                import_id, import_payee_name, import_payee_name_original)
             VALUES ($1, $2, $3, $4, $5, NULL, NULL,
                     $8, false, NULL, NULL, 'never', false, $6, $7, $7)
             RETURNING id`,
            [
              acc.budget_id,
              acc.id,
              txn.date.slice(0, 10),
              milli,
              payee.id,
              importId,
              payee.name || null,
              cleared,
            ],
          );
          await pg.query(
            `INSERT INTO connection_transactions
               (transaction_id, provider, external_transaction_id, last_synced_payload, blocked)
             VALUES ($1, $2, $3, $4, false)`,
            [
              inserted.rows[0]!.id,
              row.provider,
              txn.externalId,
              JSON.stringify({ date: txn.date.slice(0, 10), amount: milli, memo: '', payee: payee.name }),
            ],
          );
          result.added += 1;
          deltas[cleared === 'cleared' ? 'cleared_delta' : 'uncleared_delta'] += cents;
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
        await pg.query(
          `UPDATE transactions
           SET date = $2, amount = $3, memo = NULL, payee_id = $4,
               import_payee_name = $5, import_payee_name_original = $5
           WHERE id = $1`,
          [existing.id, txn.date.slice(0, 10), milli, upstreamPayee.id, upstreamPayee.name || null],
        );
        await pg.query(
          `UPDATE connection_transactions
           SET last_synced_payload = $2, updated_at = now()
           WHERE transaction_id = $1`,
          [existing.id, JSON.stringify(upstreamPayload)],
        );
        result.updated += 1;
        const bucket = existing.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
        deltas[bucket] += cents - Number(existing.amount) / 10;
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
        await pg.query('UPDATE public.transactions SET deleted = true WHERE id = $1', [trackedRow.id]);
        const bucket = trackedRow.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
        deltas[bucket] -= Number(trackedRow.amount) / 10;
        result.deleted += 1;
      }

      if (deltas.cleared_delta !== 0 || deltas.uncleared_delta !== 0) {
        await applyBalanceDeltas(pg, acc.budget_id, [
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
      await linkCardPayments(pg, budgetId);
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
