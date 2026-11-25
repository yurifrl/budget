/**
 * Budget store: applying one renaming rule to past transactions (budget-ou8p). SQL only; every function takes a
 * Queryable and every statement is scoped by budget_id. The rules (which rows, which payee) are in
 * ../domain/rename-apply.ts.
 */
import type { Queryable } from '../../core/db';
import { rawBankText } from '../../connections';
import type { RuleMatchType } from '@shared/domain/payees';
import { UNTOUCHED_LEDGER_SQL } from './transfers';

/**
 * The per-budget lock every writer of a budget's IMPORTED rows takes first: the bank sync (for the budgets of its accounts, in
 * id order, right after it locks its connection) and an apply or a revert of a renaming rule. Transaction-scoped. With it the two
 * never hold row locks in different orders, so they cannot deadlock; whoever comes second waits for the first to commit.
 */
export async function lockBudgetImportWrites(db: Queryable, budgetIds: readonly string[]): Promise<void> {
  for (const id of [...budgetIds].sort()) {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('budget-import-writes:' || $1::text, 0))", [id]);
  }
}

/** A bank-imported row an apply may look at, with the facts "untouched", "transfer" and the matcher's bank rules need. */
export interface ApplyRow {
  id: string;
  account_id: string;
  date: string;
  /** Signed milliunits. */
  amount: number;
  payee_id: string | null;
  payee_name: string | null;
  /**
   * The text the bank sent, or null when it is not known: a synced row's text comes from what the last sync recorded or the
   * stored provider object (`rawBankText`), a statement row's from its import text. Never the import name of a synced row: rows
   * stored before renaming rules assigned their payee hold the rewritten name there.
   */
  bank_text: string | null;
  /** The person picked the payee in an import screen (the stored import names differ). */
  chosen: boolean;
  category_id: string | null;
  memo: string | null;
  cleared: 'cleared' | 'uncleared' | 'reconciled';
  /** The row is a transfer already: linked, pointing at an account, or holding a transfer payee. */
  transfer: boolean;
  /** The matcher's "as imported" test (payee still as imported). */
  untouched_ledger: boolean;
  has_shadow: boolean;
  shadow_blocked: boolean | null;
  shadow_payload: { date?: string; amount?: number; memo?: string; payee?: string } | null;
  hint_account_id: string | null;
}

interface ApplyRowSql extends Omit<ApplyRow, 'bank_text'> {
  statement_text: string;
  bank_text_recorded: string | null;
  raw_description: unknown;
}

/**
 * The live bank-imported rows of open accounts of the budget whose stored text could be matched by `rule`, newest first, plus the
 * synced rows whose text is not known (they are counted, not matched). The match is made in SQL on the same text the caller uses
 * (the stored provider object's description, else the recorded one; a statement row's import text), lower-cased as
 * `normalizeRuleText` does; it is only a PREFILTER (the caller still decides which rule wins). A pattern with a non-ASCII
 * character is not prefiltered (lower() is locale dependent in SQL), so such a rule reads every imported row. `lock`: lock
 * exactly the rows read (an apply), so a concurrent edit waits for it.
 */
export async function listApplyRows(db: Queryable, budgetId: string, rule: { match_type: RuleMatchType; condition: string }, lock = false): Promise<ApplyRow[]> {
  const text = `COALESCE(CASE WHEN jsonb_typeof(cs.raw_payload->'description') = 'string' THEN NULLIF(btrim(cs.raw_payload->>'description'), '') END, cs.bank_text)`;
  const textSql = `CASE WHEN cs.transaction_id IS NOT NULL THEN ${text} ELSE NULLIF(btrim(COALESCE(t.import_payee_name_original, t.import_payee_name, '')), '') END`;
  const ascii = /^[\x00-\x7f]*$/.test(rule.condition);
  const op = { is: 'lower(X) = lower($2)', contains: 'strpos(lower(X), lower($2)) > 0', starts_with: 'starts_with(lower(X), lower($2))', ends_with: 'right(lower(X), length($2)) = lower($2)' }[rule.match_type].replaceAll('X', textSql);
  const prefilter = ascii ? `AND (${textSql} IS NULL OR ${op})` : '';
  const res = await db.query<ApplyRowSql>(
    `SELECT t.id, t.account_id, t.date::text AS date, t.amount, t.payee_id, p.name AS payee_name,
            btrim(COALESCE(t.import_payee_name_original, t.import_payee_name, '')) AS statement_text,
            cs.bank_text AS bank_text_recorded, cs.raw_payload->'description' AS raw_description,
            (t.import_payee_name IS NOT NULL AND t.import_payee_name_original IS NOT NULL
              AND t.import_payee_name <> t.import_payee_name_original) AS chosen,
            t.category_id, t.memo, t.cleared,
            (t.transfer_account_id IS NOT NULL OR t.transfer_transaction_id IS NOT NULL OR p.transfer_account_id IS NOT NULL) AS transfer,
            ${UNTOUCHED_LEDGER_SQL} AS untouched_ledger,
            (cs.transaction_id IS NOT NULL) AS has_shadow, cs.blocked AS shadow_blocked, cs.last_synced_payload AS shadow_payload,
            h.account_id AS hint_account_id
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN connection_transactions cs ON cs.transaction_id = t.id
       LEFT JOIN transfer_hints h ON h.transaction_id = t.id
      WHERE t.budget_id = $1 AND NOT t.deleted AND NOT t.upcoming AND NOT a.deleted AND NOT a.closed
        AND t.import_id IS NOT NULL
        ${prefilter}
      ORDER BY t.date DESC, t.id
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    ascii ? [budgetId, rule.condition] : [budgetId],
  );
  return res.rows.map(({ statement_text, bank_text_recorded, raw_description, ...row }) => ({
    ...row,
    // A synced row's text is the one the bank sent (recorded by the sync, else read from the stored provider object by the
    // adapter's own expression); a statement row has only its import text. Unknown (null), never guessed.
    bank_text: row.has_shadow ? ((rawBankText({ description: raw_description }) || null) ?? bank_text_recorded) : statement_text === '' ? null : statement_text,
  }));
}

/** The facts of an account the matcher's bank rules judge a pair by. */
export interface AccountSideRow {
  id: string;
  kind: 'cash' | 'card' | 'other';
  checking: boolean;
  institution: string | null;
  connection_id: string | null;
}

/** Every live account of the budget, in the candidate shape the matcher judges (same kind / bank derivation as its loader). */
export async function listAccountSides(db: Queryable, budgetId: string): Promise<AccountSideRow[]> {
  const res = await db.query<AccountSideRow>(
    `SELECT a.id,
            CASE WHEN a.type = 'creditCard' OR a.account_group = 'CREDIT' THEN 'card'
                 WHEN a.type IN ('checking','savings','cash') THEN 'cash' ELSE 'other' END AS kind,
            (a.type = 'checking') AS checking,
            COALESCE(NULLIF(btrim(a.institution), ''), c.institution) AS institution, a.connection_id
       FROM accounts a LEFT JOIN connections c ON c.id = a.connection_id
      WHERE a.budget_id = $1 AND NOT a.deleted`,
    [budgetId],
  );
  return res.rows;
}

/** Set the payee of rows (`pairs`: transaction id and payee id or null) and keep their sync shadow in step. Returns rows written. */
export async function setRowPayees(db: Queryable, budgetId: string, pairs: readonly { id: string; payeeId: string | null }[]): Promise<number> {
  if (pairs.length === 0) return 0;
  const ids = pairs.map((p) => p.id);
  const res = await db.query(
    `UPDATE transactions t SET payee_id = v.payee_id
       FROM unnest($2::uuid[], $3::uuid[]) AS v(id, payee_id)
      WHERE t.id = v.id AND t.budget_id = $1 AND NOT t.deleted`,
    [budgetId, ids, pairs.map((p) => p.payeeId)],
  );
  // A synced row's shadow keeps saying what the last sync wrote: its payee follows, so the next sync sees an unedited row.
  await db.query(
    `UPDATE connection_transactions cs
        SET last_synced_payload = jsonb_set(cs.last_synced_payload, '{payee}', to_jsonb(COALESCE(p.name, '')))
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
      WHERE cs.transaction_id = ANY($2) AND cs.budget_id = $1 AND t.id = cs.transaction_id AND t.budget_id = $1`,
    [budgetId, ids],
  );
  return res.rowCount ?? 0;
}

/** A row as a revert finds it now. */
export interface CurrentRow {
  id: string;
  account_id: string;
  payee_id: string | null;
  hint_account_id: string | null;
  has_shadow: boolean;
  shadow_blocked: boolean | null;
  shadow_payee: string | null;
  payee_name: string | null;
  /** Reconciled, linked or pointing at an account: a person or the matcher made it something an apply would never touch. */
  frozen: boolean;
}

/** Live rows of the budget among `ids` in open accounts, locked. */
export async function lockRows(db: Queryable, budgetId: string, ids: readonly string[]): Promise<CurrentRow[]> {
  if (ids.length === 0) return [];
  const res = await db.query<CurrentRow>(
    `SELECT t.id, t.account_id, t.payee_id, h.account_id AS hint_account_id, (cs.transaction_id IS NOT NULL) AS has_shadow,
            cs.blocked AS shadow_blocked, cs.last_synced_payload->>'payee' AS shadow_payee, p.name AS payee_name,
            (t.cleared = 'reconciled' OR t.transfer_account_id IS NOT NULL OR t.transfer_transaction_id IS NOT NULL OR p.transfer_account_id IS NOT NULL) AS frozen
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN connection_transactions cs ON cs.transaction_id = t.id
       LEFT JOIN transfer_hints h ON h.transaction_id = t.id
      WHERE t.budget_id = $1 AND t.id = ANY($2) AND NOT t.deleted AND NOT t.upcoming AND NOT a.deleted AND NOT a.closed
      FOR UPDATE OF t`,
    [budgetId, ids],
  );
  return res.rows;
}

/** Ids among `ids` that are live ORDINARY payees of the budget (a transfer payee is never put back on a row). */
export async function livePayeeIds(db: Queryable, budgetId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.query<{ id: string }>(
    'SELECT id FROM payees WHERE budget_id = $1 AND id = ANY($2) AND deleted = false AND transfer_account_id IS NULL',
    [budgetId, ids],
  );
  return new Set(res.rows.map((r) => r.id));
}

/** Ids among `ids` that are live, open accounts of the budget. */
export async function liveAccountIds(db: Queryable, budgetId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.query<{ id: string }>('SELECT id FROM accounts WHERE budget_id = $1 AND id = ANY($2) AND NOT deleted AND NOT closed', [budgetId, ids]);
  return new Set(res.rows.map((r) => r.id));
}

// ---- the record of an apply (rename_rule_applies / rename_rule_apply_rows, 0122) -------------------------------------------

export interface AppliedRowRecord {
  transaction_id: string;
  previous_payee_id: string | null;
  payee_id: string | null;
  previous_hint_account_id: string | null;
  hint_account_id: string | null;
}

export async function insertApply(db: Queryable, budgetId: string, ruleId: string, userId: string | null): Promise<string> {
  const res = await db.query<{ id: string }>('INSERT INTO rename_rule_applies (budget_id, rule_id, user_id) VALUES ($1, $2, $3) RETURNING id', [budgetId, ruleId, userId]);
  return res.rows[0]!.id;
}

export async function insertApplyRows(db: Queryable, budgetId: string, applyId: string, rows: readonly AppliedRowRecord[]): Promise<void> {
  if (rows.length === 0) return;
  await db.query(
    `INSERT INTO rename_rule_apply_rows (apply_id, transaction_id, budget_id, previous_payee_id, payee_id, previous_hint_account_id, hint_account_id)
     SELECT $1, v.transaction_id, $2, v.previous_payee_id, v.payee_id, v.previous_hint_account_id, v.hint_account_id
       FROM unnest($3::uuid[], $4::uuid[], $5::uuid[], $6::uuid[], $7::uuid[]) AS v(transaction_id, previous_payee_id, payee_id, previous_hint_account_id, hint_account_id)`,
    [
      applyId,
      budgetId,
      rows.map((r) => r.transaction_id),
      rows.map((r) => r.previous_payee_id),
      rows.map((r) => r.payee_id),
      rows.map((r) => r.previous_hint_account_id),
      rows.map((r) => r.hint_account_id),
    ],
  );
}

/** An apply of the budget, locked, with when it was reverted; undefined for another budget's or an unknown id. */
export async function lockApply(db: Queryable, budgetId: string, applyId: string): Promise<{ id: string; reverted: boolean } | undefined> {
  const res = await db.query<{ id: string; reverted: boolean }>(
    'SELECT id, reverted_at IS NOT NULL AS reverted FROM rename_rule_applies WHERE id = $1 AND budget_id = $2 FOR UPDATE',
    [applyId, budgetId],
  );
  return res.rows[0];
}

export async function listApplyRecordRows(db: Queryable, budgetId: string, applyId: string): Promise<AppliedRowRecord[]> {
  const res = await db.query<AppliedRowRecord>(
    `SELECT transaction_id, previous_payee_id, payee_id, previous_hint_account_id, hint_account_id
       FROM rename_rule_apply_rows WHERE apply_id = $1 AND budget_id = $2 ORDER BY transaction_id`,
    [applyId, budgetId],
  );
  return res.rows;
}

export async function markApplyReverted(db: Queryable, budgetId: string, applyId: string): Promise<void> {
  await db.query('UPDATE rename_rule_applies SET reverted_at = now() WHERE id = $1 AND budget_id = $2', [applyId, budgetId]);
}
