import type { PoolClient } from 'pg';
import type { Queryable } from '../../core/db';
import type { z } from '@shared/zod';
import { applyRules, type RenameRule } from '@shared/domain/payees';
import { HttpError } from '../../core/validate';
import { ONE_WAY_ERROR, bothPositive, type subTxnListSchema } from '@shared/contracts/budget/schemas';

/**
 * Insert one split leg. The parent keeps its null category ("Split") and its
 * signed amount is the sum of legs — enforced here, never trusted from the
 * client.
 */
export async function insertSubTxns(
  client: PoolClient,
  budgetId: string,
  txnId: string,
  subtransactions: z.output<typeof subTxnListSchema>,
) {
  for (const sub of subtransactions) {
    if (bothPositive(sub)) throw new HttpError(400, ONE_WAY_ERROR);
    if (sub.category_id) {
      const catCheck = await client.query(
        'SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2',
        [sub.category_id, budgetId],
      );
      if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget');
    }
    await client.query(
      `INSERT INTO subtransactions (budget_id, transaction_id, amount, memo, category_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [budgetId, txnId, (sub.inflow_cents - sub.outflow_cents) * 10, sub.memo, sub.category_id],
    );
  }
}

export async function loadRenameRules(client: Queryable, budgetId: string) {
  // Per-payee rules: the payee's name is the rename target.
  return client.query<RenameRule>(
    `SELECT name as replacement, rename_match_type as match_type, rename_condition as condition
     FROM payees WHERE budget_id = $1 AND deleted = false AND rename_condition IS NOT NULL
     ORDER BY created_at`,
    [budgetId],
  );
}

/**
 * Create-or-find a payee by its rule-rewritten name; empty names stay null.
 * The stored name is trimmed, except with `verbatim` (the connections sync
 * path), which keeps the name exactly as given once it is non-blank — an
 * `is` rule's replacement is a payee name used as-is there.
 */
export async function upsertPayee(
  client: PoolClient,
  budgetId: string,
  effectiveName: string,
  opts: { verbatim?: boolean } = {},
): Promise<string | null> {
  const trimmed = effectiveName.trim();
  if (!trimmed) return null;
  const name = opts.verbatim ? effectiveName : trimmed;
  const result = await client.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name)
     VALUES ($1, $2)
     ON CONFLICT (budget_id, name) DO UPDATE SET name = $2
     RETURNING id`,
    [budgetId, name],
  );
  return result.rows[0].id;
}

export async function resolvePayeeId(
  client: PoolClient,
  budgetId: string,
  name: string,
): Promise<string | null> {
  if (!name.trim()) return null;
  // Rename rules fire at transaction create/import: the stored name is the
  // rule-rewritten one, so the renamed payee is what gets created/upserted.
  const rules = await loadRenameRules(client, budgetId);
  return upsertPayee(client, budgetId, applyRules(rules.rows, name));
}

export async function applyBalanceDeltas(
  client: PoolClient,
  budgetId: string,
  deltas: BalanceDelta[],
): Promise<void> {
  for (const d of deltas) {
    const acc = await client.query<{ budget_id: string; cleared_balance: number; uncleared_balance: number }>(
      'SELECT budget_id, cleared_balance, uncleared_balance FROM accounts WHERE id = $1 FOR UPDATE',
      [d.account_id],
    );
    const row = acc.rows[0];
    // An unknown or foreign-budget account id is a client bug — fail loudly
    // instead of silently skipping the delta.
    if (!row || row.budget_id !== budgetId) {
      throw new HttpError(400, 'delta account not found in budget');
    }
    const cleared = Number(row.cleared_balance);
    const uncleared = Number(row.uncleared_balance);
    // bigint columns return numeric strings from pg; deltas arrive in cents -> *10.
    await client.query(
      'UPDATE accounts SET cleared_balance = $1, uncleared_balance = $2 WHERE id = $3',
      [cleared + d.cleared_delta * 10, uncleared + d.uncleared_delta * 10, d.account_id],
    );
  }
}

export interface TransactionInput {
  account_id: string;
  date: string;
  payee: string;
  category_id: string | null;
  memo: string;
  outflow_cents: number;
  inflow_cents: number;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  approved: boolean;
  flag: string | null;
  repeat: string;
}

export interface BalanceDelta {
  account_id: string;
  cleared_delta: number;
  uncleared_delta: number;
}

/** The ledger-relevant state of one transaction row (amount in MILLIUNITS, as stored). */
export interface LedgerRow {
  account_id: string;
  amount: number | string;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
}

/**
 * Account balance deltas (cents) when `before` (or nothing) becomes `after`
 * (or nothing): add (before = null), edit — including moving accounts or
 * cleared-status changes — and delete (after = null). Reconciled counts as
 * cleared. This is the server's single definition of the delta contract the
 * Expo client computes in modules/budget/data/ledger.accountDeltas; callers
 * that omit `deltas` on a transaction write get this result applied.
 */
export function deriveDeltas(before: LedgerRow | null, after: LedgerRow | null): BalanceDelta[] {
  const byAccount = new Map<string, BalanceDelta>();
  const apply = (row: LedgerRow, sign: 1 | -1) => {
    const d = byAccount.get(row.account_id) ?? { account_id: row.account_id, cleared_delta: 0, uncleared_delta: 0 };
    const cents = (sign * Number(row.amount)) / 10;
    if (row.cleared === 'uncleared') d.uncleared_delta += cents;
    else d.cleared_delta += cents;
    byAccount.set(row.account_id, d);
  };
  if (before) apply(before, -1);
  if (after) apply(after, 1);
  return [...byAccount.values()].filter((d) => d.cleared_delta !== 0 || d.uncleared_delta !== 0);
}

/**
 * Rebuild every account's cached cleared/uncleared balance in a budget from
 * its ledger. Used by bulk writers (restore) that insert ledger rows without
 * per-row deltas. Counts exactly what the delta path maintains — only live
 * rows (not tombstoned, not a pending `upcoming` occurrence, whose delta is
 * withheld until it flips); a split parent counts once at its own amount
 * (legs are never added) — and reuses deriveDeltas for the cleared/uncleared
 * bucketing, so that rule has one definition. Accounts with no live rows
 * reset to 0.
 */
export async function recomputeAccountBalances(client: PoolClient, budgetId: string): Promise<void> {
  await client.query(
    'UPDATE accounts SET cleared_balance = 0, uncleared_balance = 0 WHERE budget_id = $1',
    [budgetId],
  );
  const live = await client.query<LedgerRow>(
    'SELECT account_id, amount, cleared FROM transactions WHERE budget_id = $1 AND NOT deleted AND NOT upcoming',
    [budgetId],
  );
  const totals = new Map<string, BalanceDelta>();
  for (const row of live.rows) {
    for (const d of deriveDeltas(null, row)) {
      const t = totals.get(d.account_id) ?? { account_id: d.account_id, cleared_delta: 0, uncleared_delta: 0 };
      t.cleared_delta += d.cleared_delta;
      t.uncleared_delta += d.uncleared_delta;
      totals.set(d.account_id, t);
    }
  }
  await applyBalanceDeltas(client, budgetId, [...totals.values()]);
}
