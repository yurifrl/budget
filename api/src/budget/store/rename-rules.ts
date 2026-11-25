/**
 * Budget store: a payee's renaming rules (`payee_renaming_rules`, 0121). SQL
 * only; every function takes a Queryable and every statement is scoped by
 * budget_id. The matching rules live in shared/domain/payees.ts.
 *
 * The columns payees.rename_match_type / rename_condition (0016) are a MIRROR
 * of each payee's first "is"/"contains" rule, kept by `syncLegacyRuleColumns`
 * for the shared database's other app; this app never reads them back.
 */
import type { Queryable } from '../../core/db';
import type { RenameRule, RuleMatchType } from '@shared/domain/payees';

/** The unique index of a rule: one exact (match type, pattern) per budget (races on add/update map to 409). */
export const RENAME_RULE_UNIQUE = 'payee_renaming_rules_exact_key';

export interface RenameRuleRow {
  id: string;
  payee_id: string;
  match_type: RuleMatchType;
  condition: string;
  created_at: string;
}

/** A rule as matching needs it: the rule plus the payee it assigns. */
export interface LoadedRenameRule extends RenameRule {
  /** The rule's id (a rule read from the payee's old columns has the id it gets when it is made a row). */
  id: string;
  payee_id: string;
  /** The payee is an account's transfer payee: that account. */
  transfer_account_id: string | null;
  /**
   * The payee is the transfer payee of an account that is closed or gone: the rule is kept
   * but never fires (the row keeps its text as an ordinary payee). The earlier-behaviour
   * reader (domain/legacy-rename.ts) still sees it, as main did.
   */
  dead: boolean;
}

/** ISO UTC with milliseconds, the one format of `created_at` in the payee list and the rule operations. */
const CREATED_AT = (col: string) => `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
export const RULE_CREATED_AT = CREATED_AT('r.created_at');
const ROW = `r.id, r.payee_id, r.match_type, r.condition, ${RULE_CREATED_AT} AS created_at`;
const RETURNING = `id, payee_id, match_type, condition, ${CREATED_AT('created_at')} AS created_at`;

/**
 * The payee's old columns hold a rule this app should read: the other app, or the released client's old endpoint,
 * wrote it, and the table has NO is/contains rule for that payee (the columns are an input only until this app holds an
 * is/contains rule for the payee: after that the table is the truth and the mirror overwrites the columns), and no other
 * payee already holds the identical rule (the exact index would refuse it). SQL fragment over `payees <alias>`.
 */
const columnRuleMissing = (p: string) => `
  ${p}.rename_match_type IN ('is', 'contains') AND ${p}.rename_condition IS NOT NULL AND ${p}.rename_condition <> ''
  AND NOT EXISTS (SELECT 1 FROM payee_renaming_rules r2 WHERE r2.payee_id = ${p}.id AND r2.match_type IN ('is', 'contains'))
  AND NOT EXISTS (
    SELECT 1 FROM payee_renaming_rules r
     WHERE r.budget_id = ${p}.budget_id AND r.match_type = ${p}.rename_match_type AND r.condition = ${p}.rename_condition)`;

/** The id a column rule has before and after it becomes a row: stable, so a read-time id can be used in a write. */
const columnRuleId = (p: string) => `md5('column-rule:' || ${p}.id::text || ':' || ${p}.rename_match_type || ':' || ${p}.rename_condition)::uuid`;

/**
 * Every rule a payee (or the whole budget) has, as rows (id, payee_id, match_type, condition, created_at, seq): the
 * table, plus the rule only the payee's old columns hold (computed here, nothing written; `seq` null: last among equals).
 * `budget` / `payee` are SQL expressions of the caller.
 */
export const allRulesSql = (budget: string, payee: string | null = null) => `(
  SELECT r.id, r.payee_id, r.match_type, r.condition, r.created_at, r.seq
    FROM payee_renaming_rules r WHERE r.budget_id = ${budget}${payee ? ` AND r.payee_id = ${payee}` : ''}
  UNION ALL
  SELECT ${columnRuleId('cp')}, cp.id, cp.rename_match_type, cp.rename_condition, cp.created_at, NULL::bigint
    FROM payees cp WHERE cp.budget_id = ${budget}${payee ? ` AND cp.id = ${payee}` : ''} AND cp.deleted = false AND ${columnRuleMissing('cp')}
)`;

/**
 * Every rule of the budget's live payees, in the order `findRenameRule` breaks its last ties with: the rule's own
 * created_at, then its creation sequence (a rule copied from the columns is numbered by payee age, then physical order; the
 * pending column rule comes last), then id. Deterministic for NEW rows whatever the payees' created_at. The earlier-behaviour
 * reader does NOT depend on this order (it accepts every matching rule's form).
 */
export async function loadBudgetRules(db: Queryable, budgetId: string): Promise<LoadedRenameRule[]> {
  const res = await db.query<LoadedRenameRule>(
    `SELECT x.id::text AS id, x.payee_id, x.match_type, x.condition, p.name AS replacement, p.transfer_account_id,
            (p.transfer_account_id IS NOT NULL AND (a.id IS NULL OR a.deleted OR a.closed OR a.budget_id <> p.budget_id)) AS dead
       FROM ${allRulesSql('$1')} x
       JOIN payees p ON p.id = x.payee_id AND p.budget_id = $1 AND p.deleted = false
       LEFT JOIN accounts a ON a.id = p.transfer_account_id
      ORDER BY x.created_at, x.seq NULLS LAST, x.id`,
    [budgetId],
  );
  return res.rows;
}

/**
 * Make the payee's column rule a row of the table when it should be one (see columnRuleMissing), with the id it was read
 * under. Called at the start of every rule WRITE of the payee, so the mirror that follows never erases a rule written to the
 * columns by someone else. Reads never call it.
 */
export async function adoptColumnRule(db: Queryable, budgetId: string, payeeId: string): Promise<void> {
  await db.query(
    `INSERT INTO payee_renaming_rules (id, budget_id, payee_id, match_type, condition, created_at)
     SELECT ${columnRuleId('p')}, p.budget_id, p.id, p.rename_match_type, p.rename_condition, p.created_at
       FROM payees p WHERE p.budget_id = $1 AND p.id = $2 AND p.deleted = false AND ${columnRuleMissing('p')}
     ON CONFLICT DO NOTHING`,
    [budgetId, payeeId],
  );
}

const ROWS = (budget: string, payee: string) =>
  `SELECT r.id, r.payee_id, r.match_type, r.condition, ${RULE_CREATED_AT} AS created_at FROM ${allRulesSql(budget, payee)} r`;

export async function listPayeeRules(db: Queryable, budgetId: string, payeeId: string): Promise<RenameRuleRow[]> {
  const res = await db.query<RenameRuleRow>(`${ROWS('$1', '$2')} ORDER BY r.created_at, r.seq NULLS LAST, r.id`, [budgetId, payeeId]);
  return res.rows;
}

export async function getRule(db: Queryable, budgetId: string, payeeId: string, ruleId: string): Promise<RenameRuleRow | undefined> {
  const res = await db.query<RenameRuleRow>(`${ROWS('$1', '$2')} WHERE r.id = $3`, [budgetId, payeeId, ruleId]);
  return res.rows[0];
}

/**
 * The rule (and its payee's name) that already says the same thing as a NEW rule in the budget (same match
 * type, same lower-cased pattern: main treated those as one), other than `exceptRuleId`. Rules that already
 * collide (the migration keeps both) are not looked at: only a write that adds or changes a rule asks.
 */
export async function findRuleHolder(
  db: Queryable,
  budgetId: string,
  matchType: string,
  condition: string,
  exceptRuleId: string | null = null,
): Promise<{ id: string; payee_id: string; payee_name: string } | undefined> {
  const res = await db.query<{ id: string; payee_id: string; payee_name: string }>(
    `SELECT r.id, r.payee_id, p.name AS payee_name
       FROM payee_renaming_rules r JOIN payees p ON p.id = r.payee_id
      WHERE r.budget_id = $1 AND r.match_type = $2 AND lower(r.condition) = lower($3::text)
        AND ($4::uuid IS NULL OR r.id <> $4::uuid)
      LIMIT 1`,
    [budgetId, matchType, condition, exceptRuleId],
  );
  return res.rows[0];
}

export async function insertRule(db: Queryable, budgetId: string, payeeId: string, matchType: string, condition: string): Promise<RenameRuleRow> {
  const res = await db.query<RenameRuleRow>(
    `INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition) VALUES ($1, $2, $3, btrim($4))
     RETURNING ${RETURNING}`,
    [budgetId, payeeId, matchType, condition],
  );
  return res.rows[0]!;
}

export async function updateRule(db: Queryable, budgetId: string, payeeId: string, ruleId: string, matchType: string, condition: string): Promise<RenameRuleRow | undefined> {
  const res = await db.query<RenameRuleRow>(
    `UPDATE payee_renaming_rules SET match_type = $4, condition = btrim($5)
      WHERE budget_id = $1 AND payee_id = $2 AND id = $3
      RETURNING ${RETURNING}`,
    [budgetId, payeeId, ruleId, matchType, condition],
  );
  return res.rows[0];
}

export async function deleteRule(db: Queryable, budgetId: string, payeeId: string, ruleId: string): Promise<boolean> {
  const res = await db.query('DELETE FROM payee_renaming_rules WHERE budget_id = $1 AND payee_id = $2 AND id = $3', [budgetId, payeeId, ruleId]);
  return res.rowCount !== 0;
}

export async function deletePayeeRules(db: Queryable, budgetId: string, payeeId: string): Promise<void> {
  await db.query('DELETE FROM payee_renaming_rules WHERE budget_id = $1 AND payee_id = $2', [budgetId, payeeId]);
}

/** Move every rule of one payee to another of the same budget; returns how many moved. */
export async function moveRules(db: Queryable, budgetId: string, fromId: string, toId: string): Promise<number> {
  const res = await db.query('UPDATE payee_renaming_rules SET payee_id = $3 WHERE budget_id = $1 AND payee_id = $2', [budgetId, fromId, toId]);
  return res.rowCount ?? 0;
}

/** Rules per payee of the budget (repair report). */
export async function rulesByPayee(db: Queryable, budgetId: string): Promise<Map<string, RenameRuleRow[]>> {
  const res = await db.query<RenameRuleRow>(
    `SELECT ${ROW} FROM payee_renaming_rules r WHERE r.budget_id = $1 ORDER BY r.created_at, r.seq`,
    [budgetId],
  );
  const map = new Map<string, RenameRuleRow[]>();
  for (const row of res.rows) map.set(row.payee_id, [...(map.get(row.payee_id) ?? []), row]);
  return map;
}

/**
 * Keep payees.rename_match_type / rename_condition equal to the payee's first
 * "is" / "contains" rule, or NULL without one. The legacy unique index allows a
 * condition once per budget: when another payee's row already shows that text the
 * columns stay empty rather than fail (they are only a copy).
 */
export async function syncLegacyRuleColumns(db: Queryable, budgetId: string, payeeId: string): Promise<void> {
  const first = (
    await db.query<{ match_type: string; condition: string }>(
      `SELECT match_type, condition FROM payee_renaming_rules
        WHERE budget_id = $1 AND payee_id = $2 AND match_type IN ('is', 'contains')
        ORDER BY created_at, seq LIMIT 1`,
      [budgetId, payeeId],
    )
  ).rows[0];
  if (first) {
    const set = await db.query(
      `UPDATE payees SET rename_match_type = $3, rename_condition = $4
        WHERE id = $1 AND budget_id = $2
          AND NOT EXISTS (SELECT 1 FROM payees o WHERE o.budget_id = $2 AND o.rename_condition = $4 AND o.id <> $1)`,
      [payeeId, budgetId, first.match_type, first.condition],
    );
    if (set.rowCount !== 0) return;
  }
  await db.query('UPDATE payees SET rename_match_type = NULL, rename_condition = NULL WHERE id = $1 AND budget_id = $2', [payeeId, budgetId]);
}

/** The rules of a budget copied into another (`payeeMap`: temp table `pay_map(old, new)` of the caller). */
export async function copyBudgetRules(db: Queryable, fromBudgetId: string, toBudgetId: string): Promise<void> {
  await db.query(
    `INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition, created_at)
     SELECT $2, pm.new, r.match_type, r.condition, r.created_at
       FROM payee_renaming_rules r JOIN pay_map pm ON pm.old = r.payee_id
      WHERE r.budget_id = $1
      ORDER BY r.created_at, r.seq`,
    [fromBudgetId, toBudgetId],
  );
}

/**
 * Run a rule write under a savepoint: `{ ok: false }` when it hit the exact-rule unique index (a racing writer got
 * there first), any other error propagates. The caller's transaction survives either way.
 */
export async function guardRuleWrite<T>(db: Queryable, write: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  await db.query('SAVEPOINT rule_write');
  try {
    const value = await write();
    await db.query('RELEASE SAVEPOINT rule_write');
    return { ok: true, value };
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT rule_write');
    await db.query('RELEASE SAVEPOINT rule_write');
    const pgErr = err as { code?: string; constraint?: string };
    if (pgErr.code === '23505' && pgErr.constraint === RENAME_RULE_UNIQUE) return { ok: false };
    throw err;
  }
}
