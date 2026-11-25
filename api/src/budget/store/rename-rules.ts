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

/** The unique index of a rule: one (match type, normalised pattern) per budget. */
export const RENAME_RULE_UNIQUE = 'payee_renaming_rules_pattern_key';

/** The pattern normalised the way the unique index and matching compare it (SQL side). */
const NORMALISED = (column: string) => `lower(regexp_replace(btrim(${column}), '\\s+', ' ', 'g'))`;

export interface RenameRuleRow {
  id: string;
  payee_id: string;
  match_type: RuleMatchType;
  condition: string;
  created_at: string;
}

/** A rule as matching needs it: the rule plus the payee it assigns. */
export interface LoadedRenameRule extends RenameRule {
  id: string;
  payee_id: string;
  /** The payee is an account's transfer payee: that account. */
  transfer_account_id: string | null;
  /** The payee is a transfer payee of an account that is gone: the rule is kept but never fires. */
  dead: boolean;
}

const ROW = `r.id, r.payee_id, r.match_type, r.condition, r.created_at::text AS created_at`;

/**
 * Every rule of the budget's live payees, oldest first (created_at, id): the order
 * `findRenameRule` breaks its last tie with. A rule of a transfer payee whose
 * account is deleted is marked `dead` (it never fires; the earlier behaviour it
 * replaces still needs to see it, see domain/legacy-rename.ts).
 */
export async function loadBudgetRules(db: Queryable, budgetId: string): Promise<LoadedRenameRule[]> {
  const res = await db.query<LoadedRenameRule>(
    `SELECT r.id, r.payee_id, r.match_type, r.condition, p.name AS replacement, p.transfer_account_id,
            (p.transfer_account_id IS NOT NULL AND (a.id IS NULL OR a.deleted OR a.budget_id <> p.budget_id)) AS dead
       FROM payee_renaming_rules r
       JOIN payees p ON p.id = r.payee_id AND p.budget_id = r.budget_id AND p.deleted = false
       LEFT JOIN accounts a ON a.id = p.transfer_account_id
      WHERE r.budget_id = $1
      ORDER BY r.created_at, r.id`,
    [budgetId],
  );
  return res.rows;
}

export async function listPayeeRules(db: Queryable, budgetId: string, payeeId: string): Promise<RenameRuleRow[]> {
  const res = await db.query<RenameRuleRow>(
    `SELECT ${ROW} FROM payee_renaming_rules r WHERE r.budget_id = $1 AND r.payee_id = $2 ORDER BY r.created_at, r.id`,
    [budgetId, payeeId],
  );
  return res.rows;
}

export async function getRule(db: Queryable, budgetId: string, payeeId: string, ruleId: string): Promise<RenameRuleRow | undefined> {
  const res = await db.query<RenameRuleRow>(
    `SELECT ${ROW} FROM payee_renaming_rules r WHERE r.budget_id = $1 AND r.payee_id = $2 AND r.id = $3`,
    [budgetId, payeeId, ruleId],
  );
  return res.rows[0];
}

/** The rule (and its payee's name) that already holds this match type + pattern in the budget, other than `exceptRuleId`. */
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
      WHERE r.budget_id = $1 AND r.match_type = $2 AND ${NORMALISED('r.condition')} = ${NORMALISED('$3::text')}
        AND ($4::uuid IS NULL OR r.id <> $4::uuid)
      LIMIT 1`,
    [budgetId, matchType, condition, exceptRuleId],
  );
  return res.rows[0];
}

export async function insertRule(db: Queryable, budgetId: string, payeeId: string, matchType: string, condition: string): Promise<RenameRuleRow> {
  const res = await db.query<RenameRuleRow>(
    `INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition) VALUES ($1, $2, $3, btrim($4))
     RETURNING id, payee_id, match_type, condition, created_at::text AS created_at`,
    [budgetId, payeeId, matchType, condition],
  );
  return res.rows[0]!;
}

export async function updateRule(db: Queryable, budgetId: string, payeeId: string, ruleId: string, matchType: string, condition: string): Promise<RenameRuleRow | undefined> {
  const res = await db.query<RenameRuleRow>(
    `UPDATE payee_renaming_rules SET match_type = $4, condition = btrim($5)
      WHERE budget_id = $1 AND payee_id = $2 AND id = $3
      RETURNING id, payee_id, match_type, condition, created_at::text AS created_at`,
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
    `SELECT ${ROW} FROM payee_renaming_rules r WHERE r.budget_id = $1 ORDER BY r.created_at, r.id`,
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
        ORDER BY created_at, id LIMIT 1`,
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
      WHERE r.budget_id = $1`,
    [fromBudgetId, toBudgetId],
  );
}
