/**
 * Budget store: repeat rules (txn_repeat_rules). SQL only; every function
 * takes a Queryable.
 */
import type { Queryable } from '../../core/db';
import type { RepeatFrequency } from '../domain/repeat-schedule';

export async function getRepeatRuleSchedule(
  db: Queryable,
  ruleId: string,
): Promise<{ frequency: RepeatFrequency; month_last_day: boolean } | undefined> {
  const rule = await db.query<{ frequency: RepeatFrequency; month_last_day: boolean }>(
    'SELECT frequency, month_last_day FROM txn_repeat_rules WHERE id = $1',
    [ruleId],
  );
  return rule.rows[0];
}

/** Move the rule's next_due_date forward to at least `after` (never backwards). */
export async function skipRepeatRulePast(db: Queryable, ruleId: string, after: string): Promise<void> {
  await db.query('UPDATE txn_repeat_rules SET next_due_date = GREATEST(next_due_date, $1::date) WHERE id = $2', [after, ruleId]);
}

/** Passed-due upcoming occurrences become entered rows; returns what flipped. */
export async function flipPassedUpcoming(db: Queryable, budgetId: string, today: string) {
  const flipped = await db.query<{ account_id: string; amount: string }>(
    `UPDATE transactions SET upcoming = false
       WHERE budget_id = $1 AND upcoming AND NOT deleted AND date <= $2
       RETURNING account_id, amount`,
    [budgetId, today],
  );
  return { rows: flipped.rows, count: flipped.rowCount ?? 0 };
}

export interface LiveRepeatRule {
  id: string;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
  amount: string;
  frequency: RepeatFrequency;
  next_due_date: string;
  month_last_day: boolean;
}

export async function listLiveRulesForGeneration(db: Queryable, budgetId: string): Promise<LiveRepeatRule[]> {
  const rules = await db.query<LiveRepeatRule>(
    `SELECT id, account_id, payee_id, category_id, memo, amount, frequency,
              to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, month_last_day
       FROM txn_repeat_rules
       WHERE budget_id = $1 AND NOT deleted`,
    [budgetId],
  );
  return rules.rows;
}

/**
 * Materialize one upcoming occurrence; returns its id, or null when it already
 * exists (idempotent). `categoryId` is the category the occurrence carries (the
 * rule's, except for a transfer between two on-budget accounts: none).
 */
export async function insertUpcomingOccurrence(
  db: Queryable,
  budgetId: string,
  rule: LiveRepeatRule,
  date: string,
  categoryId: string | null,
): Promise<string | null> {
  const inserted = await db.query<{ id: string }>(
    `INSERT INTO transactions
               (budget_id, account_id, date, amount, payee_id, category_id, memo,
                cleared, approved, flag_color, flag_name, repeat,
                repeat_rule_id, occurrence_date, upcoming, deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'uncleared', true, NULL, NULL, $8, $9, $3, true, false)
             ON CONFLICT (repeat_rule_id, occurrence_date)
               WHERE repeat_rule_id IS NOT NULL AND deleted = false
             DO NOTHING
             RETURNING id`,
    [budgetId, rule.account_id, date, Number(rule.amount), rule.payee_id, categoryId, rule.memo, rule.frequency, rule.id],
  );
  return inserted.rows[0]?.id ?? null;
}

export async function setRuleNextDue(db: Queryable, ruleId: string, next: string): Promise<void> {
  await db.query('UPDATE txn_repeat_rules SET next_due_date = $1 WHERE id = $2', [next, ruleId]);
}

export async function budgetsWithLiveRules(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ budget_id: string }>('SELECT DISTINCT budget_id FROM txn_repeat_rules WHERE NOT deleted');
  return rows.map((r) => r.budget_id);
}

export async function listLiveRules(db: Queryable, budgetId: string) {
  const result = await db.query('SELECT * FROM txn_repeat_rules WHERE budget_id = $1 AND NOT deleted ORDER BY created_at', [budgetId]);
  return result.rows;
}

export async function getRule(db: Queryable, ruleId: string) {
  const created = await db.query('SELECT * FROM txn_repeat_rules WHERE id = $1', [ruleId]);
  return created.rows[0];
}

/** Does the account exist in this budget (any state)? */
export async function accountInBudget(db: Queryable, accountId: string, budgetId: string): Promise<boolean> {
  const accCheck = await db.query('SELECT 1 FROM accounts WHERE id = $1 AND budget_id = $2', [accountId, budgetId]);
  return accCheck.rowCount !== 0;
}

export interface AnchorRow {
  id: string;
  account_id: string;
  payee_id: string | null;
  category_id: string | null;
  memo: string | null;
  amount: string;
  date: string | Date;
  budget_id: string;
  deleted: boolean;
  repeat_rule_id: string | null;
  transfer_transaction_id: string | null;
}

/** Lock the Make Repeating anchor row. */
export async function lockAnchorTransaction(db: Queryable, transactionId: string): Promise<AnchorRow | undefined> {
  const anchor = await db.query<AnchorRow>(
    'SELECT id, account_id, payee_id, category_id, memo, amount, date, budget_id, deleted, repeat_rule_id, transfer_transaction_id FROM transactions WHERE id = $1 FOR UPDATE',
    [transactionId],
  );
  return anchor.rows[0];
}

export interface NewRepeatRule {
  budgetId: string;
  accountId: string;
  payeeId: string | null;
  categoryId: string | null;
  memo: string | null;
  /** Signed milliunits. */
  amount: number;
  frequency: RepeatFrequency;
  nextDueDate: string;
  monthLastDay: boolean;
}

export async function insertRule(db: Queryable, r: NewRepeatRule): Promise<string> {
  const rule = await db.query<{ id: string }>(
    `INSERT INTO txn_repeat_rules
           (budget_id, account_id, payee_id, category_id, memo, amount, frequency,
            next_due_date, month_last_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
    [r.budgetId, r.accountId, r.payeeId, r.categoryId, r.memo, r.amount, r.frequency, r.nextDueDate, r.monthLastDay],
  );
  return rule.rows[0].id;
}

/** Link the anchor as the rule's first instance (occurrence_date = its date). */
export async function linkAnchorToRule(
  db: Queryable,
  transactionId: string,
  ruleId: string,
  frequency: RepeatFrequency,
  upcoming: boolean,
): Promise<void> {
  await db.query(
    'UPDATE transactions SET repeat_rule_id = $1, occurrence_date = date, repeat = $2, upcoming = $3 WHERE id = $4',
    [ruleId, frequency, upcoming, transactionId],
  );
}

/**
 * The mirror of a transfer anchor that became a pending occurrence is pending
 * too (its balance delta withheld with the anchor's). Returns its ledger state
 * (to reverse the delta applied when it was entered), undefined when it is not
 * a live, entered row.
 */
export async function markMirrorUpcoming(
  db: Queryable,
  budgetId: string,
  mirrorId: string,
): Promise<{ account_id: string; amount: string; cleared: 'cleared' | 'uncleared' | 'reconciled' } | undefined> {
  const r = await db.query(
    `UPDATE transactions SET upcoming = true
      WHERE id = $1 AND budget_id = $2 AND NOT deleted AND NOT upcoming
      RETURNING account_id, amount, cleared`,
    [mirrorId, budgetId],
  );
  return r.rows[0];
}

/** Soft-delete a live rule of the budget; false when there was none. */
export async function softDeleteRuleInBudget(db: Queryable, ruleId: string, budgetId: string): Promise<boolean> {
  const rule = await db.query(
    'UPDATE txn_repeat_rules SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false RETURNING id',
    [ruleId, budgetId],
  );
  return rule.rowCount !== 0;
}

export async function deletePendingOccurrences(db: Queryable, ruleId: string): Promise<void> {
  // The pending mirrors of transfer occurrences go with them (they carry no rule id).
  await db.query(
    `UPDATE transactions SET deleted = true
      WHERE upcoming AND NOT deleted
        AND id IN (SELECT transfer_transaction_id FROM transactions
                    WHERE repeat_rule_id = $1 AND upcoming AND NOT deleted AND transfer_transaction_id IS NOT NULL)`,
    [ruleId],
  );
  await db.query('UPDATE transactions SET deleted = true WHERE repeat_rule_id = $1 AND upcoming AND NOT deleted', [ruleId]);
}

export async function detachRuleTransactions(db: Queryable, ruleId: string): Promise<void> {
  await db.query('UPDATE transactions SET repeat_rule_id = NULL WHERE repeat_rule_id = $1', [ruleId]);
}
