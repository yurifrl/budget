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
