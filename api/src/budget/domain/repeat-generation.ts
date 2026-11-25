/**
 * Repeat-rule occurrence generation (issue syscd-app-pya), moved out of
 * routes/repeat-rules.ts. Generation materializes occurrences as `upcoming`
 * transactions: visible in the register, excluded from balances until the
 * occurrence date passes. The (rule_id, occurrence_date) unique partial index
 * makes it idempotent — safe on every app load and on a periodic tick.
 */
import type { PoolClient } from 'pg';

import { pool, withTransaction } from '../../core/db';
import { applyBalanceDeltas } from './transactions';
import { findTransferPeer, insertMirror } from './transfers';
import { advanceOccurrence } from './repeat-schedule';
import {
  budgetsWithLiveRules,
  flipPassedUpcoming,
  insertUpcomingOccurrence,
  listLiveRulesForGeneration,
  type LiveRepeatRule,
  setRuleNextDue,
} from '../store/repeat-rules';

/** Upcoming occurrences are materialized this many months ahead. */
const HORIZON_MONTHS = 3;

export interface GenerationResult {
  flipped: number;
  created: number;
}

/**
 * Materialize one occurrence. A rule whose payee is an account's transfer payee
 * writes a COMPLETE transfer: the occurrence and its mirror in the peer account
 * (both pointers on both legs, each leg's payee the other account's transfer
 * payee, no category between two on-budget accounts), both upcoming so the
 * balance is withheld from both until the date passes. A transfer payee whose
 * account cannot receive one (the rule's own account, a closed or deleted
 * account) writes nothing: a payee-only half transfer is never created.
 */
async function materialize(client: PoolClient, budgetId: string, rule: LiveRepeatRule, date: string): Promise<boolean> {
  const found = await findTransferPeer(client, budgetId, rule.payee_id, rule.account_id);
  if (found.kind === 'invalid') return false;
  const peer = found.kind === 'peer' ? found.peer : null;
  const id = await insertUpcomingOccurrence(client, budgetId, rule, date, peer?.internal ? null : rule.category_id);
  if (!id) return false;
  if (peer) {
    await insertMirror(
      client,
      budgetId,
      { id, account_id: rule.account_id, date, memo: rule.memo, amount: rule.amount, cleared: 'uncleared', approved: true, upcoming: true },
      peer.accountId,
    );
  }
  return true;
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
        if (next >= today && (await materialize(client, budgetId, rule, next))) created += 1;
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
