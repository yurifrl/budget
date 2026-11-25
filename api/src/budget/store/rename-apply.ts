/**
 * Budget store: applying one renaming rule to past transactions (budget-ou8p). SQL only; every function takes a
 * Queryable and every statement is scoped by budget_id. The rules (which rows, which payee) are in
 * ../domain/rename-apply.ts.
 */
import type { Queryable } from '../../core/db';
import { UNTOUCHED_LEDGER_SQL } from './transfers';

/** A bank-imported row an apply may look at, with the facts "untouched", "transfer" and the matcher's bank rules need. */
export interface ApplyRow {
  id: string;
  account_id: string;
  date: string;
  /** Signed milliunits. */
  amount: number;
  payee_id: string | null;
  payee_name: string | null;
  /** The text the bank sent, as stored. */
  bank_text: string;
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

/**
 * Every live bank-imported row of open accounts of the budget that has a stored bank text, newest first. `lock`: lock the
 * rows (an apply), so a concurrent sync or edit waits for it.
 */
export async function listApplyRows(db: Queryable, budgetId: string, lock = false): Promise<ApplyRow[]> {
  const res = await db.query<ApplyRow>(
    `SELECT t.id, t.account_id, t.date::text AS date, t.amount, t.payee_id, p.name AS payee_name,
            btrim(COALESCE(t.import_payee_name_original, t.import_payee_name)) AS bank_text,
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
        AND btrim(COALESCE(t.import_payee_name_original, t.import_payee_name, '')) <> ''
      ORDER BY t.date DESC, t.id
      ${lock ? 'FOR UPDATE OF t' : ''}`,
    [budgetId],
  );
  return res.rows;
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
        SET last_synced_payload = jsonb_set(cs.last_synced_payload, '{payee}', to_jsonb(COALESCE(p.name, ''))), updated_at = now()
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
      WHERE cs.transaction_id = ANY($2) AND cs.budget_id = $1 AND t.id = cs.transaction_id AND t.budget_id = $1`,
    [budgetId, ids],
  );
  return res.rowCount ?? 0;
}

/** A row as a revert finds it now. */
export interface CurrentRow {
  id: string;
  payee_id: string | null;
  hint_account_id: string | null;
  has_shadow: boolean;
  shadow_blocked: boolean | null;
  shadow_payee: string | null;
  payee_name: string | null;
}

/** Live rows of the budget among `ids`, locked. */
export async function lockRows(db: Queryable, budgetId: string, ids: readonly string[]): Promise<CurrentRow[]> {
  if (ids.length === 0) return [];
  const res = await db.query<CurrentRow>(
    `SELECT t.id, t.payee_id, h.account_id AS hint_account_id, (cs.transaction_id IS NOT NULL) AS has_shadow,
            cs.blocked AS shadow_blocked, cs.last_synced_payload->>'payee' AS shadow_payee, p.name AS payee_name
       FROM transactions t
       LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN connection_transactions cs ON cs.transaction_id = t.id
       LEFT JOIN transfer_hints h ON h.transaction_id = t.id
      WHERE t.budget_id = $1 AND t.id = ANY($2) AND NOT t.deleted
      FOR UPDATE OF t`,
    [budgetId, ids],
  );
  return res.rows;
}

/** Ids among `ids` that are live payees of the budget. */
export async function livePayeeIds(db: Queryable, budgetId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.query<{ id: string }>('SELECT id FROM payees WHERE budget_id = $1 AND id = ANY($2) AND deleted = false', [budgetId, ids]);
  return new Set(res.rows.map((r) => r.id));
}

/** Ids among `ids` that are live accounts of the budget. */
export async function liveAccountIds(db: Queryable, budgetId: string, ids: readonly string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const res = await db.query<{ id: string }>('SELECT id FROM accounts WHERE budget_id = $1 AND id = ANY($2) AND NOT deleted', [budgetId, ids]);
  return new Set(res.rows.map((r) => r.id));
}
