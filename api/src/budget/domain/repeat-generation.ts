/**
 * Repeat-rule occurrence generation (issue syscd-app-pya), moved out of
 * routes/repeat-rules.ts. Generation materializes occurrences as `upcoming`
 * transactions: visible in the register, excluded from balances until the
 * occurrence date passes. The (rule_id, occurrence_date) unique partial index
 * makes it idempotent — safe on every app load and on a periodic tick.
 */
import { pool, withTransaction } from '../../core/db';
import { applyBalanceDeltas, type BalanceDelta } from './transactions';
import { findTransferPeer, insertMirror } from './transfers';
import { clearCategoryOfOnBudgetTransfers } from '../store/transfers';
import { advanceOccurrence } from './repeat-schedule';
import {
  budgetsWithLiveRules,
  flipPassedUpcoming,
  insertUpcomingOccurrence,
  listLiveRulesForGeneration,
  setRuleNextDue,
} from '../store/repeat-rules';

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
  return withTransaction(pool, async (client) => {
    const today = new Date().toISOString().slice(0, 10);

    // 1) Occurrences whose date has passed become ordinary entered
    //    transactions: apply the balance delta that was withheld when the
    //    row was materialized.
    const flipped = await flipPassedUpcoming(client, budgetId, today);
    if (flipped.rows.length > 0) {
      await applyBalanceDeltas(
        client,
        budgetId,
        flipped.rows.map((r) => ({
          account_id: r.account_id,
          cleared_delta: 0,
          uncleared_delta: Number(r.amount),
        })),
      );
      // An occurrence that is now a real transaction and whose payee is an
      // account's transfer payee becomes a COMPLETE transfer: both pointers on
      // both legs, the peer's transfer payee on the mirror, no category between
      // two on-budget accounts. Pending occurrences have no mirror (the engine
      // and the balances see them only when they flip). A payee whose account
      // cannot receive the transfer (own, closed, deleted) is left as it is.
      const mirrorDeltas: BalanceDelta[] = [];
      for (const row of flipped.rows) {
        if (row.transfer_transaction_id) continue;
        const found = await findTransferPeer(client, budgetId, row.payee_id, row.account_id);
        if (found.kind !== 'peer') continue;
        const made = await insertMirror(
          client,
          budgetId,
          { id: row.id, account_id: row.account_id, date: row.date, memo: row.memo, amount: row.amount, cleared: 'uncleared', approved: row.approved },
          found.peer.accountId,
        );
        mirrorDeltas.push(...made.deltas);
        if (found.peer.internal) await clearCategoryOfOnBudgetTransfers(client, budgetId, [row.id]);
      }
      if (mirrorDeltas.length > 0) await applyBalanceDeltas(client, budgetId, mirrorDeltas);
    }

    // 2) Materialize upcoming occurrences up to the horizon. Dates in the
    //    past are skipped — a forward-looking schedule never backfills.
    const rules = await listLiveRulesForGeneration(client, budgetId);
    const anchorToday = new Date(`${today}T00:00:00Z`);
    const horizon = new Date(
      Date.UTC(anchorToday.getUTCFullYear(), anchorToday.getUTCMonth() + HORIZON_MONTHS, anchorToday.getUTCDate()),
    )
      .toISOString()
      .slice(0, 10);

    let created = 0;
    for (const rule of rules) {
      let next = rule.next_due_date;
      // Cap guards against a pathological rule spinning the loop; 400
      // iterations cover every frequency over the 3-month window.
      for (let i = 0; next <= horizon && i < 400; i++) {
        if (next >= today) {
          if (await insertUpcomingOccurrence(client, budgetId, rule, next)) created += 1;
        }
        next = advanceOccurrence(next, rule.frequency, rule.month_last_day);
      }
      if (next !== rule.next_due_date) {
        await setRuleNextDue(client, rule.id, next);
      }
    }

    return { flipped: flipped.count, created };
  });
}

/** Periodic tick: generate every budget that has live rules (one failure never stops the rest). */
export async function generateAllBudgets(): Promise<void> {
  for (const budget_id of await budgetsWithLiveRules(pool)) {
    try {
      await generateDueOccurrences(budget_id);
    } catch (error) {
      console.error(`repeat-rule generation failed for budget ${budget_id}:`, error);
    }
  }
}
