import type { PoolClient } from 'pg';
import type { Queryable } from '../../core/db';
import type { z } from '@shared/zod';
import { applyRules, type RenameRule } from '@shared/domain/payees';
import { HttpError } from '../../core/validate';
import { ensureTransferPayee, resolveTransferAccountFromText, resolveTransferPayeeText } from './transfer-payees';
import { findPayeeRowByName, getAccountRow } from '../store/transfer-payees';
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
      if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    }
    await client.query(
      `INSERT INTO subtransactions (budget_id, transaction_id, amount, memo, category_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [budgetId, txnId, sub.inflow - sub.outflow, sub.memo, sub.category_id],
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
  client: Queryable,
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

/**
 * Create-or-find a payee for a statement/register TEXT (already rule-rewritten):
 * a "Transfer : <account>" text means that account's transfer payee (same
 * resolution everywhere: register, import, bank sync); any other text is an
 * ordinary payee created by name. `fromRule` = a renaming rule produced the
 * text, so it already is a payee's name.
 */
export async function upsertPayeeResolvingTransfers(
  client: PoolClient,
  budgetId: string,
  effectiveName: string,
  opts: { verbatim?: boolean; fromRule?: boolean } = {},
): Promise<string | null> {
  const trimmed = effectiveName.trim();
  if (!trimmed) return null;
  const transferPayee = await resolveTransferPayeeText(client, budgetId, trimmed, { fromRule: opts.fromRule });
  return transferPayee ?? upsertPayee(client, budgetId, effectiveName, { verbatim: opts.verbatim });
}

/** What an imported row's payee text means; computed with reads only (see `planImportedPayee`). */
export interface ImportedPayeePlan {
  /** The ordinary payee name a NEW row is stored with (not yet created), or null when it gets no payee. */
  ordinaryName: string | null;
  /** The stored payee's name ('' when none): what the sync shadow says. */
  name: string;
  /** The name the row's `import_payee_name` keeps: the bank's text, also when the stored payee is none. */
  importName: string;
  /** The account the payee text pointed at ("Transfer : <account>", as text or through a renaming rule), if any. */
  transferAccountId: string | null;
  /**
   * What the bank sync stored before imports stopped storing transfer payees: the
   * account's transfer payee under the rule-rewritten text. A row stored that way
   * (payee-only, from an earlier sync) is NOT changed by a later sync: its payee is
   * compared and kept against this name, never against `name`. Null when the text
   * names no account.
   */
  legacyName: string | null;
}

/**
 * Decide what an imported row's payee text means, WITHOUT writing anything (a
 * re-sync of rows that do not change must not create payees). An import never
 * stores an account's transfer payee without the transfer behind it (a
 * payee-only half transfer; the other side may arrive from the other bank): when
 * the text (after the renaming rules) means "Transfer : <account>", a NEW row
 * keeps the ordinary payee of the RAW text and the account is returned for a
 * transfer hint. A raw text that is itself the name of a transfer payee leaves the
 * row without a payee (its text stays in `importName`). Other text is an ordinary
 * payee, as before.
 */
export async function planImportedPayee(
  client: Queryable,
  budgetId: string,
  rawText: string,
  effective: string,
  opts: { verbatim?: boolean } = {},
): Promise<ImportedPayeePlan> {
  const trimmed = effective.trim();
  if (!trimmed) return { ordinaryName: null, name: '', importName: '', transferAccountId: null, legacyName: null };
  const raw = rawText.trim();
  const accountId = await resolveTransferAccountFromText(client, budgetId, trimmed, { fromRule: trimmed !== raw });
  if (!accountId) return { ordinaryName: effective, name: effective, importName: effective, transferAccountId: null, legacyName: null };
  const holder = raw ? await findPayeeRowByName(client, budgetId, raw) : undefined;
  if (!raw || (holder && (holder.transfer_account_id !== null || holder.deleted))) {
    return { ordinaryName: null, name: '', importName: effective, transferAccountId: accountId, legacyName: effective };
  }
  const name = opts.verbatim ? rawText : raw;
  return { ordinaryName: name, name, importName: name, transferAccountId: accountId, legacyName: effective };
}

/** The payee of a NEW imported row (bank sync, statement import): the plan, written. */
export interface ImportedPayee extends ImportedPayeePlan {
  /** The payee the row is stored with: ordinary or null, NEVER an account's transfer payee. */
  id: string | null;
  /** The id the row counts under when the text names an account: that account's transfer payee (statement-import idempotency keys). */
  transferPayeeId: string | null;
}

export async function resolveImportedPayee(
  client: PoolClient,
  budgetId: string,
  rawText: string,
  effective: string,
  opts: { verbatim?: boolean } = {},
): Promise<ImportedPayee> {
  let plan = await planImportedPayee(client, budgetId, rawText, effective, opts);
  let transferPayeeId: string | null = null;
  if (plan.transferAccountId) {
    // The account's payee exists (or is created) BEFORE the raw text is judged: a legacy
    // account's name-only "Transfer : X" payee becomes its transfer payee here, so the raw
    // text of the same name is recognised as that payee and never stored as an ordinary one.
    transferPayeeId = await ensureTransferPayee(client, budgetId, plan.transferAccountId);
    plan = await planImportedPayee(client, budgetId, rawText, effective, opts);
  }
  const id = plan.ordinaryName === null ? null : await upsertPayee(client, budgetId, plan.ordinaryName, { verbatim: opts.verbatim });
  return { ...plan, id, transferPayeeId };
}

/**
 * The payee of one statement-import name (POST /bulk) with the writes deferred:
 *  - `key` is the id the row counts under in its `YNAB:<milli>:<date>:<payee>`
 *    import id. It is what main used: for text that names an account, the id main
 *    resolved to (the account's own pointer when it has one, else its payee, created
 *    only when the account has none), otherwise the ordinary payee's id;
 *  - `ordinaryId()` creates the ordinary payee of the raw text ONLY when a row is
 *    actually inserted, so re-importing a file whose rows are all duplicates creates
 *    no payee.
 */
export interface StatementPayee {
  plan: ImportedPayeePlan;
  key: string | null;
  ordinaryId(): Promise<string | null>;
}

export async function resolveStatementPayee(client: PoolClient, budgetId: string, rawText: string, effective: string): Promise<StatementPayee> {
  let plan = await planImportedPayee(client, budgetId, rawText, effective);
  let key: string | null = null;
  if (plan.transferAccountId) {
    const account = await getAccountRow(client, plan.transferAccountId);
    key = account?.transfer_payee_id ?? (await ensureTransferPayee(client, budgetId, plan.transferAccountId));
    // ensureTransferPayee may have adopted a name-only payee: judge the raw text again.
    plan = await planImportedPayee(client, budgetId, rawText, effective);
  }
  let ordinary: Promise<string | null> | null = null;
  const ordinaryId = () => {
    ordinary ??= plan.ordinaryName === null ? Promise.resolve(null) : upsertPayee(client, budgetId, plan.ordinaryName);
    return ordinary;
  };
  if (!plan.transferAccountId && plan.ordinaryName !== null) {
    // An existing payee is found without a write; a new one is needed now (its rows are new).
    const existing = await findPayeeRowByName(client, budgetId, plan.ordinaryName.trim());
    key = existing ? existing.id : await ordinaryId();
  }
  return { plan, key, ordinaryId };
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
  const effective = applyRules(rules.rows, name);
  return upsertPayeeResolvingTransfers(client, budgetId, effective, { fromRule: effective !== name });
}

export async function applyBalanceDeltas(
  client: Queryable,
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
      throw new HttpError(400, 'delta account not found in budget', 'account_not_in_budget');
    }
    const cleared = Number(row.cleared_balance);
    const uncleared = Number(row.uncleared_balance);
    // bigint columns return numeric strings from pg; deltas are milliunits, like the columns.
    await client.query(
      'UPDATE accounts SET cleared_balance = $1, uncleared_balance = $2 WHERE id = $3',
      [cleared + d.cleared_delta, uncleared + d.uncleared_delta, d.account_id],
    );
  }
}

/** A change to one account's cached balances, in MILLIUNITS (the balance columns' unit). */
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
 * Account balance deltas (milliunits) when `before` (or nothing) becomes `after`
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
    const milli = sign * Number(row.amount);
    if (row.cleared === 'uncleared') d.uncleared_delta += milli;
    else d.cleared_delta += milli;
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
