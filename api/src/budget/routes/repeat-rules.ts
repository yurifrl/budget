/**
 * repeat-rules — recurring transactions engine (issue syscd-app-pya).
 *
 * txn_repeat_rules holds the schedule template (payee/account/category/
 * amount/memo + frequency, next_due_date, month_last_day). Generation
 * materializes occurrences as `upcoming` transactions: visible in the
 * register with a Repeat badge, but excluded from budget activity and
 * account balances until the occurrence date passes (YNAB behavior). The
 * (rule_id, occurrence_date) unique partial index makes generation
 * idempotent — safe to run on every app load and on a boot tick.
 *
 * Make Repeating (POST /) links an anchor transaction to a fresh rule; when
 * the anchor is future-dated it is retroactively marked upcoming and its
 * entry balance delta is reversed.
 */

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { repeatRulesCreate, repeatRulesDelete, repeatRulesGenerate, repeatRulesList } from '@shared/contracts/budget';
import { applyBalanceDeltas, resolvePayeeId } from '../domain/transactions';
import { advanceOccurrence, isoDate, type RepeatFrequency } from '../domain/repeat-schedule';
import { budgetRouter } from '../router';

/** Upcoming occurrences are materialized this many months ahead. */
const HORIZON_MONTHS = 3;

export interface GenerationResult {
  flipped: number;
  created: number;
}

/**
 * Flip passed-due upcoming transactions to entered (applying the balance
 * delta withheld at materialization) and materialize each live rule's
 * occurrences within the horizon. Idempotent.
 */
export async function generateDueOccurrences(budgetId: string): Promise<GenerationResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const today = new Date().toISOString().slice(0, 10);

    // 1) Occurrences whose date has passed become ordinary entered
    //    transactions: apply the balance delta that was withheld when the
    //    row was materialized.
    const flipped = await client.query<{ account_id: string; amount: string }>(
      `UPDATE transactions SET upcoming = false
       WHERE budget_id = $1 AND upcoming AND NOT deleted AND date <= $2
       RETURNING account_id, amount`,
      [budgetId, today],
    );
    if (flipped.rows.length > 0) {
      await applyBalanceDeltas(
        client,
        budgetId,
        flipped.rows.map((r) => ({
          account_id: r.account_id,
          cleared_delta: 0,
          uncleared_delta: Number(r.amount) / 10,
        })),
      );
    }

    // 2) Materialize upcoming occurrences up to the horizon. Dates in the
    //    past are skipped — a forward-looking schedule never backfills.
    const rules = await client.query<{
      id: string;
      account_id: string;
      payee_id: string | null;
      category_id: string | null;
      memo: string | null;
      amount: string;
      frequency: RepeatFrequency;
      next_due_date: string;
      month_last_day: boolean;
    }>(
      `SELECT id, account_id, payee_id, category_id, memo, amount, frequency,
              to_char(next_due_date, 'YYYY-MM-DD') AS next_due_date, month_last_day
       FROM txn_repeat_rules
       WHERE budget_id = $1 AND NOT deleted`,
      [budgetId],
    );
    const anchorToday = new Date(`${today}T00:00:00Z`);
    const horizon = new Date(
      Date.UTC(anchorToday.getUTCFullYear(), anchorToday.getUTCMonth() + HORIZON_MONTHS, anchorToday.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);

    let created = 0;
    for (const rule of rules.rows) {
      let next = rule.next_due_date;
      // Cap guards against a pathological rule spinning the loop; 400
      // iterations cover every frequency over the 3-month window.
      for (let i = 0; next <= horizon && i < 400; i++) {
        if (next >= today) {
          const inserted = await client.query(
            `INSERT INTO transactions
               (budget_id, account_id, date, amount, payee_id, category_id, memo,
                cleared, approved, flag_color, flag_name, repeat,
                repeat_rule_id, occurrence_date, upcoming, deleted)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 'uncleared', true, NULL, NULL, $8, $9, $3, true, false)
             ON CONFLICT (repeat_rule_id, occurrence_date)
               WHERE repeat_rule_id IS NOT NULL AND deleted = false
             DO NOTHING`,
            [
              budgetId,
              rule.account_id,
              next,
              Number(rule.amount),
              rule.payee_id,
              rule.category_id,
              rule.memo,
              rule.frequency,
              rule.id,
            ],
          );
          if (inserted.rowCount ?? 0) created += 1;
        }
        next = advanceOccurrence(next, rule.frequency, rule.month_last_day);
      }
      if (next !== rule.next_due_date) {
        await client.query('UPDATE txn_repeat_rules SET next_due_date = $1 WHERE id = $2', [next, rule.id]);
      }
    }

    await client.query('COMMIT');
    return { flipped: flipped.rowCount ?? 0, created };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Boot/interval tick: generate every budget that has live rules. */
export async function generateAllBudgets(): Promise<void> {
  const { rows } = await pool.query<{ budget_id: string }>(
    'SELECT DISTINCT budget_id FROM txn_repeat_rules WHERE NOT deleted',
  );
  for (const { budget_id } of rows) {
    try {
      await generateDueOccurrences(budget_id);
    } catch (error) {
      console.error(`repeat-rule generation failed for budget ${budget_id}:`, error);
    }
  }
}

export const operations = [
  implement(repeatRulesList, async (_c, { budget_id }) => {
    const result = await pool.query(
      'SELECT * FROM txn_repeat_rules WHERE budget_id = $1 AND NOT deleted ORDER BY created_at',
      [budget_id],
    );
    return result.rows;
  }),

  implement(repeatRulesCreate, async (_c, body) => {
    if (body.inflow_cents > 0 && body.outflow_cents > 0) {
      throw new HttpError(400, 'inflow_cents and outflow_cents cannot both be positive');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Referenced account must belong to this budget; otherwise the rule
      // would generate cross-budget transactions.
      const accCheck = await client.query('SELECT 1 FROM accounts WHERE id = $1 AND budget_id = $2', [
        body.account_id,
        body.budget_id,
      ]);
      if (accCheck.rowCount === 0) throw new HttpError(400, 'account not found in budget');

      let ruleId: string;
      if (body.attach_transaction_id) {
        // Make Repeating: the anchor transaction is the series' first instance.
        // Template fields come from the anchor row (authoritative), not the
        // request body.
        const anchor = await client.query<{
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
        }>(
          'SELECT id, account_id, payee_id, category_id, memo, amount, date, budget_id, deleted, repeat_rule_id FROM transactions WHERE id = $1 FOR UPDATE',
          [body.attach_transaction_id],
        );
        const t = anchor.rows[0];
        if (!t || t.budget_id !== body.budget_id || t.deleted) {
          throw new HttpError(400, 'attach transaction not found in budget');
        }
        if (t.repeat_rule_id) {
          throw new HttpError(409, 'transaction is already repeating');
        }
        const anchorDate = isoDate(t.date);
        const nextDue = advanceOccurrence(anchorDate, body.frequency, body.month_last_day);
        const rule = await client.query<{ id: string }>(
          `INSERT INTO txn_repeat_rules
           (budget_id, account_id, payee_id, category_id, memo, amount, frequency,
            next_due_date, month_last_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
          [
            body.budget_id,
            t.account_id,
            t.payee_id,
            t.category_id,
            t.memo,
            Number(t.amount),
            body.frequency,
            nextDue,
            body.month_last_day,
          ],
        );
        ruleId = rule.rows[0].id;

        // The anchor stays in the register as the first instance. A future-
        // dated anchor is upcoming: link it, flag it, and reverse the balance
        // delta its entry applied (withheld until the date passes).
        const upcoming = anchorDate > new Date().toISOString().slice(0, 10);
        await client.query(
          'UPDATE transactions SET repeat_rule_id = $1, occurrence_date = date, repeat = $2, upcoming = $3 WHERE id = $4',
          [ruleId, body.frequency, upcoming, t.id],
        );
        if (upcoming) {
          await applyBalanceDeltas(client, body.budget_id, [
            { account_id: t.account_id, cleared_delta: 0, uncleared_delta: -Number(t.amount) / 10 },
          ]);
        }
      } else {
        if (!body.next_due_date) {
          throw new HttpError(400, 'next_due_date or attach_transaction_id is required');
        }
        if (body.category_id) {
          const catCheck = await client.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [
            body.category_id,
            body.budget_id,
          ]);
          if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget');
        }
        const payeeId = await resolvePayeeId(client, body.budget_id, body.payee);
        const rule = await client.query<{ id: string }>(
          `INSERT INTO txn_repeat_rules
           (budget_id, account_id, payee_id, category_id, memo, amount, frequency,
            next_due_date, month_last_day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING id`,
          [
            body.budget_id,
            body.account_id,
            payeeId,
            body.category_id,
            body.memo || null,
            (body.inflow_cents - body.outflow_cents) * 10,
            body.frequency,
            body.next_due_date,
            body.month_last_day,
          ],
        );
        ruleId = rule.rows[0].id;
      }

      await client.query('COMMIT');
      // Materialize due occurrences right away so the register shows the
      // upcoming instances immediately (Make Repeating keeps the entered txn
      // and schedules the series). Generation is idempotent.
      await generateDueOccurrences(body.budget_id);
      const created = await pool.query('SELECT * FROM txn_repeat_rules WHERE id = $1', [ruleId]);
      return created.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),

  implement(repeatRulesGenerate, async (_c, { budget_id }) => generateDueOccurrences(budget_id)),

  implement(repeatRulesDelete, async (_c, { id, budget_id: budgetId }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const rule = await client.query(
        'UPDATE txn_repeat_rules SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false RETURNING id',
        [id, budgetId],
      );
      if (rule.rowCount === 0) throw new HttpError(404, 'repeat rule not found');
      // Pending upcoming instances die with the rule. Their balance deltas
      // were withheld at materialization, so there is nothing to reverse.
      await client.query(
        'UPDATE transactions SET deleted = true WHERE repeat_rule_id = $1 AND upcoming AND NOT deleted',
        [id],
      );
      // Surviving rows (the anchor / entered instances) become free-standing
      // transactions again — no dangling reference to a dead rule.
      await client.query('UPDATE transactions SET repeat_rule_id = NULL WHERE repeat_rule_id = $1', [id]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
];

export default budgetRouter('/repeat-rules', operations);
