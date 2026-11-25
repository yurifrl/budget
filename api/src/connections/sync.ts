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
 * Each row runs under its own SAVEPOINT: an unexpected per-row error rolls
 * back that row only (counted in `failed`). Bank-id identity is per budget:
 * a bank id already imported in the same budget (deleted, or into another
 * account of that budget) is skipped and counted, never inserted twice, so
 * re-running a sync is always a no-op. Budgets are isolated: every budget
 * whose account links the upstream account imports its own copy.
 *
 * Every write into budget's tables (payees, imported rows, refreshes,
 * tombstones, balance deltas, card-payment pairing) goes through budget's
 * `ledger` API (src/budget/ledger.ts, via the budget barrel). The shadow
 * table `connection_transactions` is this feature's own.
 */

import { pool, type Queryable } from '../core/db';
import { ledger } from '../budget';
import { HttpError } from '../core/validate';
import { getConnectionByUser, setConnectionInstitution, withLinkedBy, type ConnectionRow, type ConnectionWithLinker } from './store';
import { ALL_HISTORY_DAYS, effectiveSyncWindowDays, getSyncWindowDays } from './settings';
import type { AggregatedTransaction, BankAggregator, TransactionPull } from './types';
import { isPaidInstallmentCopy, PAID_INSTALLMENT_REASON } from './installments';

/** Counts reported to the caller. */
export interface SyncResult {
  added: number;
  updated: number;
  deleted: number;
  /** Rows skipped because they were user-modified or not engine-owned. */
  blocked: number;
  /** Engine-owned rows already matching upstream — the idempotent no-ops. */
  duplicates: number;
  /** Bank ids imported before and since deleted (by the user or a sync tombstone): they stay deleted. */
  skipped_deleted: number;
  /** Bank ids already imported into another account of the same budget (e.g. an unlinked one): they stay there. */
  skipped_other_account: number;
  /** Where the `skipped_other_account` rows live (always accounts of the same budget). */
  skipped_accounts: SkippedAccount[];
  /** PENDING card installments already imported as POSTED (Itaú's copy after an early payment): not imported. */
  skipped_paid_installment: number;
  /** Rows that failed unexpectedly; each rolled back alone, the rest committed. */
  failed: number;
  /** The first failures (capped at MAX_RECORDED_FAILURES), for the job log. Not user-facing. */
  failures: SyncFailure[];
}

export interface SkippedAccount {
  account_id: string;
  name: string;
  count: number;
}

export interface SyncFailure {
  external_id: string;
  reason: string;
}

const MAX_RECORDED_FAILURES = 20;
const MAX_REASON_LENGTH = 300;

export const emptySyncResult = (): SyncResult => ({
  added: 0,
  updated: 0,
  deleted: 0,
  blocked: 0,
  duplicates: 0,
  skipped_deleted: 0,
  skipped_other_account: 0,
  skipped_accounts: [],
  skipped_paid_installment: 0,
  failed: 0,
  failures: [],
});

/** Where a bank id was imported before in this budget, whatever its state. */
interface PriorImport {
  transaction_id: string;
  account_id: string;
  account_name: string;
  deleted: boolean;
}

/**
 * The row a bank id was imported as in this budget, in any of its accounts,
 * deleted or not (the shadow key is unique per budget). Other budgets are
 * never looked at: each imports its own copy.
 */
async function findImportedBankId(
  pg: Queryable,
  budgetId: string,
  provider: string,
  externalId: string,
): Promise<PriorImport | undefined> {
  const found = await pg.query<PriorImport>(
    `SELECT t.id AS transaction_id, t.account_id, ac.name AS account_name, t.deleted
     FROM public.connection_transactions s
     JOIN public.transactions t ON t.id = s.transaction_id
     JOIN public.accounts ac ON ac.id = t.account_id
     WHERE s.budget_id = $1 AND s.provider = $2 AND s.external_transaction_id = $3`,
    [budgetId, provider, externalId],
  );
  return found.rows[0];
}

/**
 * Count a bank id that is already imported in this budget. Deleted wins (it
 * stays deleted); a live row in another account of the budget stays there; a
 * live row in this account that the import-id lookup missed is left alone
 * (blocked).
 */
function recordSkip(result: SyncResult, prior: PriorImport, acc: LinkedAccountRow): void {
  if (prior.deleted) {
    result.skipped_deleted += 1;
    return;
  }
  if (prior.account_id === acc.id) {
    result.blocked += 1;
    return;
  }
  result.skipped_other_account += 1;
  const entry = result.skipped_accounts.find((a) => a.account_id === prior.account_id);
  if (entry) entry.count += 1;
  else
    result.skipped_accounts.push({ account_id: prior.account_id, name: prior.account_name, count: 1 });
}

function recordFailure(result: SyncResult, externalId: string, err: unknown): void {
  result.failed += 1;
  const reason = (err instanceof Error ? err.message : String(err)).slice(0, MAX_REASON_LENGTH);
  if (result.failures.length < MAX_RECORDED_FAILURES) result.failures.push({ external_id: externalId, reason });
  console.warn(`Connections sync: bank transaction ${externalId} failed to import: ${reason}`);
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
  /** ISO 4217 code; null until set by the user or adopted from the provider. */
  currency: string | null;
}

const ISO_4217 = /^[A-Z]{3}$/;

/**
 * Provider currency per upstream account id, fetched only when some linked
 * account has no currency yet (G1). Best-effort: a provider failure, timeout
 * or adapter without account listing yields an empty map and the sync goes
 * on — currency never blocks importing transactions.
 */
async function upstreamCurrencies(
  aggregator: BankAggregator,
  externalItemId: string,
  linked: readonly LinkedAccountRow[],
  timeoutMs: number,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!linked.some((a) => a.currency == null)) return out;
  try {
    const accounts = await withTimeout(
      aggregator.listExternalAccounts(externalItemId),
      timeoutMs,
      `upstream listExternalAccounts(${externalItemId})`,
    );
    for (const account of accounts) {
      const code = account.currencyCode?.trim().toUpperCase();
      if (code && ISO_4217.test(code)) out.set(account.externalId, code);
    }
  } catch {
    /* best-effort: the next sync tries again */
  }
  return out;
}

interface ExistingTxnRow {
  id: string;
  date: string;
  /** Signed milliunits (bigint → string). */
  amount: number;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  payee_name: string | null;
  payee_id: string | null;
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
  /** True only when upstream reported the swept window [sweepFrom, to] fully paginated. */
  complete: boolean;
  /** Lower bound of the tombstone sweep: exactly what the window pull covered. */
  sweepFrom: string;
  /** History-import resume point to store; null = clear it (done); undefined = leave as is. */
  backfill: BackfillPoint | null | undefined;
}

// ---- pull modes ------------------------------------------------------------
//
// full:   first sync of an account (nothing imported into it yet) or Re-import
//         history. Pages until the provider has nothing older or the sync
//         window starts, up to FULL_IMPORT_MAX_ROWS rows. Hitting the cap
//         stores a resume point (connection_account_backfill).
// resume: an account with a stored resume point: a daily pull, plus the next
//         older pages from the resume point (again up to the cap) until done.
// daily:  every other sync (poller, webhook, Sync now): only the last
//         DAILY_SYNC_DAYS days, re-pulled whole so pending→posted changes and
//         late rows are caught. The sweep covers only that window.

export type PullMode = 'full' | 'resume' | 'daily';

/** Days a daily (regular) sync re-pulls, ending today. */
export const DAILY_SYNC_DAYS = 30;
/**
 * Safety cap on rows one history pull collects per account per sync (whole
 * provider pages, so it can overshoot by one page). Past it, the pull stops,
 * stores where it got to and the next syncs continue from there.
 */
export const FULL_IMPORT_MAX_ROWS = 10_000;
/** Upper bound for one account's history pull (all pages; the job heartbeats meanwhile). */
export const FULL_IMPORT_TIMEOUT_MS = 10 * 60_000;

/** Where a capped history import continues (one row per account in connection_account_backfill). */
export interface BackfillPoint {
  cursor: string | null;
  /** Oldest date reached (YYYY-MM-DD), the inclusive upper bound still to import. */
  before_date: string;
  rows_pulled: number;
}

/** Lower bound of a daily pull: the last DAILY_SYNC_DAYS days, never past the sync window. */
export function dailyPullFrom(windowDays: number): string {
  const daily = isoDaysAgo(DAILY_SYNC_DAYS);
  const windowFloor = pullFrom(null, windowDays);
  return windowFloor != null && windowFloor > daily ? windowFloor : daily;
}

/** Which pull each account gets this sync. */
export function choosePullMode(input: { reimport: boolean; hasBackfill: boolean; hasImports: boolean }): PullMode {
  if (input.reimport) return 'full';
  if (input.hasBackfill) return 'resume';
  return input.hasImports ? 'daily' : 'full';
}

/** Resume points and "has anything been imported" per account. */
async function loadPullState(
  pg: Queryable,
  accountIds: readonly string[],
): Promise<{ backfill: Map<string, BackfillPoint>; imported: Set<string> }> {
  const backfill = new Map<string, BackfillPoint>();
  const imported = new Set<string>();
  if (accountIds.length === 0) return { backfill, imported };
  const points = await pg.query<{ account_id: string } & BackfillPoint>(
    `SELECT account_id, cursor, before_date::text AS before_date, rows_pulled
     FROM public.connection_account_backfill WHERE account_id = ANY($1::uuid[])`,
    [accountIds],
  );
  for (const { account_id, ...point } of points.rows) backfill.set(account_id, point);
  const withRows = await pg.query<{ id: string }>(
    `SELECT a.id FROM unnest($1::uuid[]) AS a(id)
     WHERE EXISTS (SELECT 1 FROM public.transactions t
                   JOIN public.connection_transactions s ON s.transaction_id = t.id
                   WHERE t.account_id = a.id)`,
    [accountIds],
  );
  for (const { id } of withRows.rows) imported.add(id);
  return { backfill, imported };
}

async function saveBackfill(pg: Queryable, accountId: string, point: BackfillPoint | null): Promise<void> {
  if (point == null) {
    await pg.query('DELETE FROM public.connection_account_backfill WHERE account_id = $1', [accountId]);
    return;
  }
  await pg.query(
    `INSERT INTO public.connection_account_backfill (account_id, cursor, before_date, rows_pulled)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (account_id) DO UPDATE
       SET cursor = EXCLUDED.cursor, before_date = EXCLUDED.before_date,
           rows_pulled = EXCLUDED.rows_pulled, updated_at = now()`,
    [accountId, point.cursor, point.before_date, point.rows_pulled],
  );
}

/** Where a history pull that stopped early continues; null when it reached the end. */
function nextBackfill(pull: TransactionPull, to: string, previousRows: number): BackfillPoint | null {
  if (!pull.hasMore) return null;
  return {
    cursor: pull.cursor ?? null,
    before_date: pull.oldestDate ?? to,
    rows_pulled: previousRows + pull.transactions.length,
  };
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
  /** Re-import history: every account gets a full pull (see PullMode), resume points restart. */
  ignoreWatermark?: boolean;
  /** Per-account upstream pull timeout (test seam; defaults to UPSTREAM_TIMEOUT_MS, FULL_IMPORT_TIMEOUT_MS for history pulls). */
  upstreamTimeoutMs?: number;
  /** Per-account row cap of a history pull (test seam; defaults to FULL_IMPORT_MAX_ROWS). */
  fullImportMaxRows?: number;
  /** Called between accounts and per upstream row in phase 2 (job heartbeat; keep it cheap). */
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
  // Kept only for the race check in phase 2; pull windows come from the mode.
  const snapshotAt = snapshot.rows[0]?.last_synced_at ?? null;
  const windowDays = effectiveSyncWindowDays(row.sync_window_days, await getSyncWindowDays());
  const windowFrom = pullFrom(null, windowDays);
  const dailyFrom = dailyPullFrom(windowDays);
  const to = today();
  const maxRows = input.fullImportMaxRows ?? FULL_IMPORT_MAX_ROWS;

  // Budget accounts linked to upstream accounts of this connection:
  // unlinked accounts are skipped — mirroring is a budget-module concern.
  const linkedSql = `SELECT ac.id, ac.budget_id, ac.external_account_id, ac.currency
         FROM public.accounts ac
         JOIN public.connections c ON c.id = ac.connection_id
         WHERE ac.connection_id = $1 AND ac.external_account_id IS NOT NULL
           AND ac.deleted = false`;
  const linked = (await pool.query<LinkedAccountRow>(linkedSql, [row.id])).rows;

  const timeoutMs = input.upstreamTimeoutMs ?? UPSTREAM_TIMEOUT_MS;
  const historyTimeoutMs = input.upstreamTimeoutMs ?? FULL_IMPORT_TIMEOUT_MS;
  const pullState = await loadPullState(pool, linked.map((a) => a.id));
  const fetched = new Map<string, FetchedAccount>();
  // Phase timings, logged once per pass so a slow sync is diagnosable from logs.
  const startedAt = Date.now();
  const timings: Record<string, unknown> = { pull_ms: {} as Record<string, number> };
  for (const acc of linked) {
    const pullStart = Date.now();
    const point = pullState.backfill.get(acc.id);
    const mode = choosePullMode({
      reimport: input.ignoreWatermark === true,
      hasBackfill: point !== undefined,
      hasImports: pullState.imported.has(acc.id),
    });
    const pull = (window: { from: string | null; to: string; cursor?: string | null }, ms: number) =>
      withTimeout(
        aggregator.listTransactions(acc.external_account_id, {
          ...(window.from != null ? { from: window.from } : {}),
          to: window.to,
          maxResults: maxRows,
          ...(window.cursor != null ? { cursor: window.cursor } : {}),
          ...(input.onProgress ? { onPage: input.onProgress } : {}),
        }),
        ms,
        `upstream listTransactions(${acc.external_account_id})`,
      );

    let entry: FetchedAccount;
    let history: TransactionPull | undefined;
    if (mode === 'full') {
      // The whole window, newest first. Complete = the sweep may cover it all
      // (All history is an arbitrarily old floor in SQL rather than NULL).
      history = await pull({ from: windowFrom, to }, historyTimeoutMs);
      entry = {
        acc,
        transactions: history.transactions,
        complete: !history.hasMore,
        sweepFrom: windowFrom ?? '0001-01-01',
        backfill: nextBackfill(history, to, 0),
      };
    } else {
      const daily = await pull({ from: dailyFrom, to }, timeoutMs);
      entry = { acc, transactions: daily.transactions, complete: !daily.hasMore, sweepFrom: dailyFrom, backfill: undefined };
      if (mode === 'resume' && point) {
        // Older pages from the stored point. Never swept: this pull covers
        // only part of the window.
        history = await pull({ from: windowFrom, to: point.before_date, cursor: point.cursor }, historyTimeoutMs);
        const have = new Set(entry.transactions.map((t) => t.externalId));
        entry.transactions = [...entry.transactions, ...history.transactions.filter((t) => !have.has(t.externalId))];
        entry.backfill = nextBackfill(history, point.before_date, point.rows_pulled);
      }
      if (mode === 'daily') history = daily;
    }
    fetched.set(acc.id, entry);
    console.info(
      `Connections sync ${row.id}: pull ${JSON.stringify({
        account: acc.external_account_id,
        mode,
        from: mode === 'full' ? windowFrom : mode === 'daily' ? dailyFrom : point?.before_date,
        pages: history?.pages ?? null,
        rows: history?.transactions.length ?? 0,
        oldest: history?.oldestDate ?? null,
        hit_cap: history?.hasMore ?? false,
        ...(mode === 'resume' ? { daily_rows: entry.transactions.length - (history?.transactions.length ?? 0) } : {}),
      })}`,
    );
    (timings.pull_ms as Record<string, number>)[acc.external_account_id] = Date.now() - pullStart;
    input.onProgress?.();
  }
  const currencies = await upstreamCurrencies(aggregator, row.external_id, linked, timeoutMs);
  await input.beforeCommit?.();

  // ---- Phase 2: short write transaction ---------------------------------
  let rowsStart = Date.now();
  let rowCount = 0;
  const pg = await pool.connect();
  try {
    await pg.query('BEGIN');

    const result = emptySyncResult();

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
    rowsStart = Date.now();

    for (const { id } of stillLinked) {
      const pulled = fetched.get(id);
      if (!pulled) continue;
      const { acc } = pulled;
      // G1: adopt the provider's currency while the account has none (a
      // user-set value is never overwritten; the UPDATE re-checks IS NULL).
      const code = currencies.get(acc.external_account_id);
      if (code) await ledger.adoptAccountCurrency(pg, acc.id, code);
      const upstream = { transactions: pulled.transactions };
      const seen = new Set(upstream.transactions.map((txn) => txn.externalId));

      input.onProgress?.();
      // Budget's ledger API: rename rules + create-or-find, cached per batch.
      let resolver = ledger.createImportPayeeResolver(pg, acc.budget_id);
      const deltas: AccountDeltas = { cleared_delta: 0, uncleared_delta: 0 };

      for (const txn of upstream.transactions) {
        input.onProgress?.();
        rowCount += 1;
        // One SAVEPOINT per row: an unexpected failure rolls back that row
        // alone (counted in `failed`), the rest of the batch still commits.
        // Every upstream id is in `seen`, so the sweep never touches a
        // skipped or failed row's target.
        const before = { result: structuredClone(result), deltas: { ...deltas } };
        await pg.query('SAVEPOINT sync_row');
        // False only while a failed row's rollback itself fails (the outer catch then aborts the run).
        let savepointUsable = true;
        try {
          const milli = txn.amount;
          const importId = `${row.provider}:${txn.externalId}`;
          const existing = (
            await pg.query<ExistingTxnRow>(
              `SELECT t.id, t.date::text AS date, t.amount, t.memo, t.cleared,
                      p.name AS payee_name, t.payee_id,
                      s.blocked AS shadow_blocked, s.last_synced_payload AS shadow_payload
               FROM public.transactions t
               LEFT JOIN public.connection_transactions s ON s.transaction_id = t.id
               LEFT JOIN public.payees p ON p.id = t.payee_id
               WHERE t.account_id = $1 AND t.import_id = $2 AND NOT t.deleted`,
              [acc.id, importId],
            )
          ).rows[0];

          if (!existing) {
            // The shadow key (budget, provider, bank id) is per budget: a bank
            // id already imported in this budget (deleted, or into another of
            // its accounts) is skipped, never inserted twice. Another budget's
            // copy is not a conflict.
            const prior = await findImportedBankId(pg, acc.budget_id, row.provider, txn.externalId);
            if (prior) {
              recordSkip(result, prior, acc);
              continue;
            }
            if (await isPaidInstallmentCopy(pg, acc.id, txn)) {
              result.skipped_paid_installment += 1;
              console.info(`Connections sync: bank transaction ${txn.externalId} skipped: ${PAID_INSTALLMENT_REASON}`);
              continue;
            }
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
              importPayeeName: payee.importName || null,
              cleared,
            });
            // The text said "Transfer : <account>": the row stays an ordinary uncategorized
            // one (no payee-only half transfer, no mirror: the other side may arrive from the
            // other bank) and the matcher is told which account it is probably with.
            if (payee.transferAccountId && payee.transferAccountId !== acc.id) {
              await ledger.setTransferHint(pg, acc.budget_id, insertedId, payee.transferAccountId);
            }
            await pg.query(
              `INSERT INTO connection_transactions
                 (transaction_id, budget_id, provider, external_transaction_id, last_synced_payload, blocked,
                  raw_payload, raw_received_at)
               VALUES ($1, $2, $3, $4, $5, false, $6, now())`,
              [
                insertedId,
                acc.budget_id,
                row.provider,
                txn.externalId,
                JSON.stringify({ date: txn.date.slice(0, 10), amount: milli, memo: '', payee: payee.name }),
                JSON.stringify(txn.raw),
              ],
            );
            result.added += 1;
            deltas[cleared === 'cleared' ? 'cleared_delta' : 'uncleared_delta'] += milli;
            continue;
          }

          // Metadata only: refresh the provider's raw object on every pull of a
          // shadowed row, whatever the engine decides below (blocked, duplicate,
          // updated). Inside the row's savepoint, so a failed row rolls it back
          // too. Never touches user-visible fields or updated_at. Skipped bank
          // ids (deleted, or imported into another account) get no raw write.
          if (existing.shadow_payload != null) {
            await pg.query(
              'UPDATE connection_transactions SET raw_payload = $2, raw_received_at = now() WHERE transaction_id = $1',
              [existing.id, JSON.stringify(txn.raw)],
            );
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

          // What the text means, read only: a row that stays as it is must not create payees.
          const upstreamPayee = await resolver.peek(txn.description);
          // The ledger's read-back form is date-only (`t.date::text`); compare
          // like with like so unchanged upstream rows stay duplicates. The payee is
          // compared in BOTH forms the same bank text has been stored in: what a new
          // row gets now (ordinary payee, no transfer payee) and what an earlier sync
          // stored (the account's transfer payee). Either one is "unchanged".
          const upstreamPayload = (payee: string): OwnedPayload => ({
            date: txn.date.slice(0, 10),
            amount: milli,
            memo: '',
            payee,
          });
          const legacyForm = upstreamPayee.legacyName !== null && current.payee === upstreamPayee.legacyName;
          // A row an earlier import stored with the payee a `contains` rule used to splice
          // into the text ("Padaria 42") is unchanged too: a matching rule assigns its payee
          // from now on, for the rows inserted and the rows the bank changes, not for rows
          // that are as the bank sent them.
          const earlierForm = upstreamPayee.earlierNames.includes(current.payee);
          if (samePayload(current, upstreamPayload(upstreamPayee.name)) || ((legacyForm || earlierForm) && samePayload(current, upstreamPayload(current.payee)))) {
            result.duplicates += 1;
            continue;
          }

          // Upstream changed a row the user left untouched → refresh the owned
          // fields; cleared/approved state is preserved. A row an earlier sync stored
          // with the transfer payee keeps it (the engine never rewrites a payee only
          // because transfer text is resolved differently now).
          const keep = legacyForm;
          // The row is being changed: ONE resolve() decides payee, shadow name, import name
          // and hint, so the row and its shadow always agree (a peek made before the
          // resolve could adopt a name-only payee would disagree with the stored row,
          // and the next sync would freeze it).
          const resolved = keep ? null : await resolver.resolve(txn.description);
          const payeeId = resolved ? resolved.id : existing.payee_id;
          const storedName = resolved ? resolved.name : current.payee;
          await ledger.refreshImportedTransaction(pg, existing.id, {
            date: txn.date.slice(0, 10),
            amount: milli,
            payeeId,
            importPayeeName: (resolved ? resolved.importName : current.payee) || null,
          });
          // The hint follows the row: a refreshed row of transfer text keeps or gets it, any other text drops it.
          if (resolved) {
            if (resolved.transferAccountId && resolved.transferAccountId !== acc.id) {
              await ledger.setTransferHint(pg, acc.budget_id, existing.id, resolved.transferAccountId);
            } else {
              await ledger.clearTransferHints(pg, acc.budget_id, [existing.id]);
            }
          }
          await pg.query(
            `UPDATE connection_transactions
             SET last_synced_payload = $2, updated_at = now()
             WHERE transaction_id = $1`,
            [existing.id, JSON.stringify(upstreamPayload(storedName))],
          );
          result.updated += 1;
          const bucket = existing.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
          deltas[bucket] += milli - Number(existing.amount);
        } catch (err) {
          savepointUsable = false;
          await pg.query('ROLLBACK TO SAVEPOINT sync_row');
          savepointUsable = true;
          Object.assign(result, before.result);
          Object.assign(deltas, before.deltas);
          // The rollback may have undone a payee the resolver cached.
          resolver = ledger.createImportPayeeResolver(pg, acc.budget_id);
          recordFailure(result, txn.externalId, err);
        } finally {
          if (savepointUsable) await pg.query('RELEASE SAVEPOINT sync_row');
        }
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
          [acc.id, pulled.sweepFrom, to],
        )
      ).rows : [];
      for (const trackedRow of tracked) {
        input.onProgress?.();
        if (seen.has(trackedRow.external_transaction_id)) continue;
        await ledger.tombstoneTransaction(pg, trackedRow.id);
        const bucket = trackedRow.cleared === 'uncleared' ? 'uncleared_delta' : 'cleared_delta';
        deltas[bucket] -= Number(trackedRow.amount);
        result.deleted += 1;
      }
      if (pulled.backfill !== undefined) await saveBackfill(pg, acc.id, pulled.backfill);

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

    timings.rows = rowCount;
    timings.rows_ms = Date.now() - rowsStart;

    // Pair transfers between the budget's own accounts (card payments, PIX/TED
    // between own accounts, payee rules); idempotent, so it also backfills
    // rows imported earlier.
    const linkStart = Date.now();
    for (const budgetId of new Set(stillLinked.filter((a) => fetched.has(a.id)).map((a) => a.budget_id))) {
      input.onProgress?.();
      await ledger.linkTransfers(pg, budgetId);
    }
    timings.link_transfers_ms = Date.now() - linkStart;

    await pg.query(
      'UPDATE public.connections SET last_synced_at = now(), updated_at = now() WHERE id = $1',
      [row.id],
    );

    await input.beforeCommit?.();
    const commitStart = Date.now();
    await pg.query('COMMIT');
    timings.commit_ms = Date.now() - commitStart;
    timings.total_ms = Date.now() - startedAt;
    console.info(`Connections sync ${row.id}: timings ${JSON.stringify(timings)}`);
    if (result.skipped_deleted + result.skipped_other_account + result.failed > 0) {
      console.warn(
        `Connections sync ${row.id}: skipped ${result.skipped_deleted} deleted and ${result.skipped_other_account} imported into another account; ${result.failed} failed`,
      );
    }
    return result;
  } catch (err) {
    timings.rows = rowCount;
    timings.rows_ms ??= Date.now() - rowsStart;
    timings.total_ms = Date.now() - startedAt;
    console.warn(`Connections sync ${row.id}: rolled back; timings so far ${JSON.stringify(timings)}`);
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
  /** Re-import history: a full pull of every account (see PullMode). */
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
