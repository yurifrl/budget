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
 * Generation lives in ../domain/repeat-generation.ts, SQL in
 * ../store/repeat-rules.ts.
 *
 * Make Repeating (POST /) links an anchor transaction to a fresh rule; when
 * the anchor is future-dated it is retroactively marked upcoming and its
 * entry balance delta is reversed.
 */

import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { repeatRulesCreate, repeatRulesDelete, repeatRulesGenerate, repeatRulesList } from '@shared/contracts/budget';
import { ONE_WAY_ERROR, bothPositive } from '@shared/contracts/budget/schemas';
import { applyBalanceDeltas, resolvePayeeId } from '../domain/transactions';
import { advanceOccurrence, isoDate } from '../domain/repeat-schedule';
import { generateDueOccurrences } from '../domain/repeat-generation';
import { budgetRouter } from '../router';
import { categoryInBudget } from '../store/categories';
import * as rulesStore from '../store/repeat-rules';

export const operations = [
  implement(repeatRulesList, async (_c, { budget_id }) => {
    return rulesStore.listLiveRules(pool, budget_id);
  }),

  implement(repeatRulesCreate, async (_c, body) => {
    if (bothPositive(body)) {
      throw new HttpError(400, ONE_WAY_ERROR);
    }
    const ruleId = await withTransaction(pool, async (client) => {
      // Referenced account must belong to this budget; otherwise the rule
      // would generate cross-budget transactions.
      if (!(await rulesStore.accountInBudget(client, body.account_id, body.budget_id))) {
        throw new HttpError(400, 'account not found in budget');
      }

      let ruleId: string;
      if (body.attach_transaction_id) {
        // Make Repeating: the anchor transaction is the series' first instance.
        // Template fields come from the anchor row (authoritative), not the
        // request body.
        const t = await rulesStore.lockAnchorTransaction(client, body.attach_transaction_id);
        if (!t || t.budget_id !== body.budget_id || t.deleted) {
          throw new HttpError(400, 'attach transaction not found in budget');
        }
        if (t.repeat_rule_id) {
          throw new HttpError(409, 'transaction is already repeating');
        }
        const anchorDate = isoDate(t.date);
        const nextDue = advanceOccurrence(anchorDate, body.frequency, body.month_last_day);
        ruleId = await rulesStore.insertRule(client, {
          budgetId: body.budget_id,
          accountId: t.account_id,
          payeeId: t.payee_id,
          categoryId: t.category_id,
          memo: t.memo,
          amount: Number(t.amount),
          frequency: body.frequency,
          nextDueDate: nextDue,
          monthLastDay: body.month_last_day,
        });

        // The anchor stays in the register as the first instance. A future-
        // dated anchor is upcoming: link it, flag it, and reverse the balance
        // delta its entry applied (withheld until the date passes).
        const upcoming = anchorDate > new Date().toISOString().slice(0, 10);
        await rulesStore.linkAnchorToRule(client, t.id, ruleId, body.frequency, upcoming);
        if (upcoming) {
          await applyBalanceDeltas(client, body.budget_id, [
            { account_id: t.account_id, cleared_delta: 0, uncleared_delta: -Number(t.amount) },
          ]);
        }
      } else {
        if (!body.next_due_date) {
          throw new HttpError(400, 'next_due_date or attach_transaction_id is required');
        }
        if (body.category_id) {
          if (!(await categoryInBudget(client, body.category_id, body.budget_id))) {
            throw new HttpError(400, 'category not found in budget');
          }
        }
        const payeeId = await resolvePayeeId(client, body.budget_id, body.payee);
        ruleId = await rulesStore.insertRule(client, {
          budgetId: body.budget_id,
          accountId: body.account_id,
          payeeId,
          categoryId: body.category_id,
          memo: body.memo || null,
          amount: body.inflow - body.outflow,
          frequency: body.frequency,
          nextDueDate: body.next_due_date,
          monthLastDay: body.month_last_day,
        });
      }

      return ruleId;
    });

    // Materialize due occurrences right away so the register shows the
    // upcoming instances immediately (Make Repeating keeps the entered txn
    // and schedules the series). Generation is idempotent.
    await generateDueOccurrences(body.budget_id);
    return rulesStore.getRule(pool, ruleId);
  }),

  implement(repeatRulesGenerate, async (_c, { budget_id }) => generateDueOccurrences(budget_id)),

  implement(repeatRulesDelete, async (_c, { id, budget_id: budgetId }) => {
    return withTransaction(pool, async (client) => {
      if (!(await rulesStore.softDeleteRuleInBudget(client, id, budgetId))) throw new HttpError(404, 'repeat rule not found');
      // Pending upcoming instances die with the rule. Their balance deltas
      // were withheld at materialization, so there is nothing to reverse.
      await rulesStore.deletePendingOccurrences(client, id);
      // Surviving rows (the anchor / entered instances) become free-standing
      // transactions again — no dangling reference to a dead rule.
      await rulesStore.detachRuleTransactions(client, id);
    });
  }),
];

export default budgetRouter('/repeat-rules', operations);
