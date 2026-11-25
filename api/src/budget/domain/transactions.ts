import type { PoolClient } from 'pg';
import type { Queryable } from '../../core/db';
import type { z } from '@shared/zod';
import { findRenameRule } from '@shared/domain/payees';
import { HttpError } from '../../core/validate';
import { ensureTransferPayee, resolveTransferAccountFromText, resolveTransferPayeeText } from './transfer-payees';
import { findPayeeRowByName, getAccountRow, getPayeeRow } from '../store/transfer-payees';
import { loadBudgetRules, type LoadedRenameRule } from '../store/rename-rules';
import { legacyEffectiveText } from './legacy-rename';
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

/** The budget's renaming rules, oldest first (see `store/rename-rules.ts`). */
export type RenameRules = readonly LoadedRenameRule[];

export function loadRenameRules(client: Queryable, budgetId: string): Promise<LoadedRenameRule[]> {
  return loadBudgetRules(client, budgetId);
}

/**
 * The rule that decides a text, or null. A rule of a transfer payee whose
 * account is gone never fires. Most specific first (see `findRenameRule`).
 */
export function matchingRule(rules: RenameRules, text: string): LoadedRenameRule | null {
  return findRenameRule(
    rules.filter((r) => !r.dead),
    text,
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
  /** A renaming rule assigned this ordinary payee: the row is stored with exactly it (never looked up by name). */
  assignedPayeeId: string | null;
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
  /**
   * What the behaviour before "a rule assigns its payee" stored for the same text
   * (see legacy-rename.ts), when it differs from the text itself: a `contains` rule
   * used to splice its payee's name into the text ("Padaria 42", "Transfer : X 42").
   * Rows stored that way are recognised, never rewritten; null when nothing differs.
   */
  earlier: TextPlan | null;
}

type TextPlan = Omit<ImportedPayeePlan, 'assignedPayeeId' | 'earlier'>;

/**
 * What a TEXT means as a payee, with no rule involved: the text itself, or the
 * name a rule rewrote it to (`effective`). The one behaviour before rules assigned
 * their payee, kept for the texts no rule matches and to read what earlier imports
 * stored (`ImportedPayeePlan.earlier`).
 */
async function planTextPayee(
  client: Queryable,
  budgetId: string,
  rawText: string,
  effective: string,
  opts: { verbatim?: boolean } = {},
): Promise<TextPlan> {
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

/**
 * Decide what an imported row's payee text means, WITHOUT writing anything (a
 * re-sync of rows that do not change must not create payees).
 *
 * A renaming rule that matches ASSIGNS its payee (the most specific rule when
 * several match, see `findRenameRule`); the imported text is kept as the row's
 * import name. When that payee is an account's transfer payee, the row stays an
 * ordinary uncategorized one: an import never stores an account's transfer payee
 * without the transfer behind it (a payee-only half transfer; the other side may
 * arrive from the other bank). It keeps the ordinary payee of the RAW text, and the
 * account is returned for a transfer hint. A raw text that is itself the name of a
 * transfer payee leaves the row without a payee (its text stays in `importName`).
 * Text no rule matches is an ordinary payee, or, when it reads "Transfer : <account>",
 * the same hinted row.
 */
export async function planImportedPayee(
  client: Queryable,
  budgetId: string,
  rawText: string,
  rules: RenameRules,
  opts: { verbatim?: boolean } = {},
): Promise<ImportedPayeePlan> {
  const raw = rawText.trim();
  if (!raw) {
    return { ordinaryName: null, assignedPayeeId: null, name: '', importName: '', transferAccountId: null, legacyName: null, earlier: null };
  }
  const hit = matchingRule(rules, raw);
  const earlierText = legacyEffectiveText(rules, raw);
  const earlier = earlierText !== raw ? await planTextPayee(client, budgetId, raw, earlierText, opts) : null;
  if (!hit) return { ...(await planTextPayee(client, budgetId, rawText, raw, opts)), assignedPayeeId: null, earlier };
  if (!hit.transfer_account_id) {
    return {
      ordinaryName: hit.replacement,
      assignedPayeeId: hit.payee_id,
      name: hit.replacement,
      importName: opts.verbatim ? rawText : raw,
      transferAccountId: null,
      legacyName: null,
      earlier,
    };
  }
  const holder = await findPayeeRowByName(client, budgetId, raw);
  if (holder && (holder.transfer_account_id !== null || holder.deleted)) {
    return { ordinaryName: null, assignedPayeeId: null, name: '', importName: raw, transferAccountId: hit.transfer_account_id, legacyName: hit.replacement, earlier };
  }
  const name = opts.verbatim ? rawText : raw;
  return { ordinaryName: name, assignedPayeeId: null, name, importName: name, transferAccountId: hit.transfer_account_id, legacyName: hit.replacement, earlier };
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
  rules: RenameRules,
  opts: { verbatim?: boolean } = {},
): Promise<ImportedPayee> {
  let plan = await planImportedPayee(client, budgetId, rawText, rules, opts);
  let transferPayeeId: string | null = null;
  if (plan.transferAccountId) {
    // The account's payee exists (or is created) BEFORE the raw text is judged: a legacy
    // account's name-only "Transfer : X" payee becomes its transfer payee here, so the raw
    // text of the same name is recognised as that payee and never stored as an ordinary one.
    transferPayeeId = await ensureTransferPayee(client, budgetId, plan.transferAccountId);
    plan = await planImportedPayee(client, budgetId, rawText, rules, opts);
  }
  const id =
    plan.assignedPayeeId ??
    (plan.ordinaryName === null ? null : await upsertPayee(client, budgetId, plan.ordinaryName, { verbatim: opts.verbatim }));
  return { ...plan, id, transferPayeeId };
}

/**
 * The payee of one statement-import name (POST /bulk) with the writes deferred:
 *  - `key()` is the id the row counts under in its `YNAB:<milli>:<date>:<payee>`
 *    import id. It is what the import always used: for text that names an account, the
 *    id it resolved to (the account's own pointer when it has one, else its payee,
 *    created only when the account has none), otherwise the ordinary payee's id (an
 *    assigned payee's own id). Called only for rows without an import id;
 *  - `earlierKeys()` are the ids the same text counted under when a `contains` rule
 *    still spliced its payee into the text; read only (nothing is created), so a file
 *    imported back then is still recognised;
 *  - `existingPayeeId()` is the payee a row can be inserted with without any write
 *    (undefined: the ordinary payee does not exist yet), `createPayee()` creates it:
 *    called only for a row that was actually inserted, so a re-import of rows that
 *    exist creates no payee.
 */
export interface StatementPayee {
  plan: ImportedPayeePlan;
  key(): Promise<string | null>;
  earlierKeys(): Promise<string[]>;
  existingPayeeId(): Promise<string | null | undefined>;
  createPayee(): Promise<string | null>;
}

export async function resolveStatementPayee(client: PoolClient, budgetId: string, rawText: string, rules: RenameRules): Promise<StatementPayee> {
  let plan = await planImportedPayee(client, budgetId, rawText, rules);
  let accountKey: string | null = null;
  if (plan.transferAccountId) {
    const account = await getAccountRow(client, plan.transferAccountId);
    accountKey = account?.transfer_payee_id ?? (await ensureTransferPayee(client, budgetId, plan.transferAccountId));
    if (account?.transfer_payee_id) {
      // A pointer at ANOTHER account's payee (bad data) stays the key, as it always was, but the
      // account still needs its own linked payee, or the raw text "Transfer : <account>" would be
      // stored as an ordinary payee of that name.
      const pointed = await getPayeeRow(client, budgetId, account.transfer_payee_id);
      if (pointed && pointed.transfer_account_id !== null && pointed.transfer_account_id !== plan.transferAccountId) {
        await ensureTransferPayee(client, budgetId, plan.transferAccountId);
      }
    }
    // ensureTransferPayee may have adopted a name-only payee: judge the raw text again.
    plan = await planImportedPayee(client, budgetId, rawText, rules);
  }
  let created: Promise<string | null> | null = null;
  const createPayee = () => {
    created ??=
      plan.assignedPayeeId !== null
        ? Promise.resolve(plan.assignedPayeeId)
        : plan.ordinaryName === null
          ? Promise.resolve(null)
          : upsertPayee(client, budgetId, plan.ordinaryName);
    return created;
  };
  let keyed: Promise<string | null> | null = null;
  const key = () => {
    keyed ??= (async () => {
      if (plan.transferAccountId) return accountKey;
      if (plan.assignedPayeeId !== null) return plan.assignedPayeeId;
      if (plan.ordinaryName === null) return null;
      // An existing payee is found without a write; a new one is needed now (its rows are new).
      const existing = await findPayeeRowByName(client, budgetId, plan.ordinaryName.trim());
      return existing ? existing.id : createPayee();
    })();
    return keyed;
  };
  const existingPayeeId = async (): Promise<string | null | undefined> => {
    if (plan.assignedPayeeId !== null) return plan.assignedPayeeId;
    if (plan.ordinaryName === null) return null;
    if (created) return created;
    return (await findPayeeRowByName(client, budgetId, plan.ordinaryName.trim()))?.id;
  };
  const earlierKeys = async (): Promise<string[]> => {
    const earlier = plan.earlier;
    if (!earlier) return [];
    if (earlier.transferAccountId) {
      const pointer = (await getAccountRow(client, earlier.transferAccountId))?.transfer_payee_id;
      return pointer ? [pointer] : [];
    }
    if (earlier.ordinaryName === null) return [];
    const holder = await findPayeeRowByName(client, budgetId, earlier.ordinaryName.trim());
    return holder ? [holder.id] : [];
  };
  return { plan, key, earlierKeys, existingPayeeId, createPayee };
}

export async function resolvePayeeId(
  client: PoolClient,
  budgetId: string,
  name: string,
): Promise<string | null> {
  if (!name.trim()) return null;
  // A renaming rule that matches assigns its payee (a transfer payee makes the row a
  // transfer, with its mirror); the text is only parsed as "Transfer : <account>" when
  // no rule matches.
  const hit = matchingRule(await loadRenameRules(client, budgetId), name);
  if (hit) return hit.transfer_account_id ? ensureTransferPayee(client, budgetId, hit.transfer_account_id) : hit.payee_id;
  return upsertPayeeResolvingTransfers(client, budgetId, name);
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
