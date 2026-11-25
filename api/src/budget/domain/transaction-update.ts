/**
 * The transaction PATCH path, extracted so OTHER features (categorize accept/
 * undo) can run it inside their own transaction and get the same validation,
 * balance derivation, transfer sync, upcoming-occurrence handling and budget
 * revision trigger as budget_transactions_update. The HTTP handler is a thin
 * wrapper around this function.
 */
import type { PoolClient } from 'pg';

import type { z } from '@shared/zod';

import { HttpError } from '../../core/validate';
import { ONE_WAY_ERROR, bothPositive, patchTxnSchema, subTxnListSchema } from '@shared/contracts/budget/schemas';
import { applyBalanceDeltas, deriveDeltas, insertSubTxns } from './transactions';
import { resolveEditedPayee } from './edited-payee';
import { resolveTransferPeer, syncMirror } from './transfers';
import { advanceOccurrence } from './repeat-schedule';
import { suggestedCategoryForPayee } from './categorization';
import { findAccountInBudget } from '../store/accounts';
import { categoryInBudget } from '../store/categories';
import { getRepeatRuleSchedule, skipRepeatRulePast } from '../store/repeat-rules';
import * as txnStore from '../store/transactions';

type PatchTxn = z.output<typeof patchTxnSchema>;
type SubTxnList = z.output<typeof subTxnListSchema>;

export async function updateTransactionInClient(
  client: PoolClient,
  params: {
    budgetId: string;
    id: string;
    patch: PatchTxn;
    subtransactions: SubTxnList | undefined;
  },
): Promise<void> {
  const { budgetId: budget_id, id, patch, subtransactions } = params;
  if (bothPositive({ inflow: patch.inflow ?? 0, outflow: patch.outflow ?? 0 })) {
    throw new HttpError(400, ONE_WAY_ERROR);
  }

  // The transaction must exist, belong to this budget, and not be deleted;
  // otherwise the update would silently mutate another budget's row.
  const existing = await txnStore.getLiveTransactionInBudget(client, id, budget_id);
  if (!existing) throw new HttpError(404, 'transaction not found');
  const existingPayeeId = existing.payee_id;
  const existingCategory = existing.category_id;
  if (patch.account_id !== undefined) {
    const acc = await findAccountInBudget(client, patch.account_id, budget_id);
    if (!acc) throw new HttpError(400, 'account not found in budget', 'account_not_in_budget');
    // Closed accounts are immutable — no moving rows into them (YNAB parity).
    if (acc.closed) throw new HttpError(409, 'account is closed', 'account_closed');
  }
  // A referenced category / matched counterpart must belong to this budget
  // (create and bulk already check the category; an edit must too).
  if (patch.category_id) {
    if (!(await categoryInBudget(client, patch.category_id, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
  }
  if (patch.matched_transaction_id) {
    if (!(await txnStore.transactionInBudget(client, patch.matched_transaction_id, budget_id))) {
      throw new HttpError(400, 'matched transaction not found in budget');
    }
  }
  if (patch.category_id && (subtransactions?.length ?? 0) > 0) {
    throw new HttpError(400, 'split transactions cannot carry a category_id', 'split_cannot_have_category');
  }

  const set: txnStore.TxnSetEntry[] = [];

  if (patch.account_id !== undefined) set.push({ col: 'account_id', value: patch.account_id });
  if (patch.date !== undefined) set.push({ col: 'date', value: patch.date });
  if (patch.category_id !== undefined) set.push({ col: 'category_id', value: patch.category_id });
  if (patch.memo !== undefined) set.push({ col: 'memo', value: patch.memo || null });
  if (patch.cleared !== undefined) set.push({ col: 'cleared', value: patch.cleared });
  if (patch.approved !== undefined) set.push({ col: 'approved', value: patch.approved });
  if (patch.flag !== undefined) set.push({ col: 'flag_color', value: patch.flag });
  if (patch.repeat !== undefined) set.push({ col: 'repeat', value: patch.repeat });
  // Match/unmatch (syscd-app-42f): both sides of a matched pair store the
  // same linked id; unmatch clears both. No FK check — the counterpart is
  // validated client-side and scoped by budget_id on read.
  if (patch.matched_transaction_id !== undefined) {
    set.push({ col: 'matched_transaction_id', value: patch.matched_transaction_id });
  }
  if (patch.outflow !== undefined || patch.inflow !== undefined) {
    const amount = (patch.inflow ?? 0) - (patch.outflow ?? 0);
    set.push({ col: 'amount', value: amount });
  }

  // Editing a pending upcoming occurrence of a repeat rule detaches it:
  // YNAB turns the future instance into a free-standing transaction and
  // the rule's next_due_date skips past the occurrence instead. The
  // withheld balance delta is applied as part of the flip (the client's
  // edit delta then re-balances the edited amounts on top).
  if (Object.keys(patch).length > 0 && existing.upcoming && existing.repeat_rule_id) {
    set.push({ raw: 'repeat_rule_id = NULL' }, { raw: 'occurrence_date = NULL' }, { raw: 'upcoming = false' });
    await applyBalanceDeltas(client, budget_id, [
      {
        account_id: existing.account_id,
        cleared_delta: 0,
        uncleared_delta: Number(existing.amount),
      },
    ]);
    const rule = await getRepeatRuleSchedule(client, existing.repeat_rule_id);
    if (rule && existing.occurrence_date) {
      const after = advanceOccurrence(existing.occurrence_date, rule.frequency, rule.month_last_day);
      await skipRepeatRulePast(client, existing.repeat_rule_id, after);
    }
  }
  // Set when the edit changes the payee: the transfer link must follow it.
  let payeeChanged = false;
  let transferPeer: Awaited<ReturnType<typeof resolveTransferPeer>> = null;
  if (patch.payee !== undefined || patch.payee_id !== undefined) {
    const edited = await resolveEditedPayee(client, budget_id, existing, { payeeId: patch.payee_id, text: patch.payee });
    if (!edited.unchanged) {
      const payeeId = edited.payeeId;
      if (payeeId !== existingPayeeId) {
        payeeChanged = true;
        transferPeer = await resolveTransferPeer(client, budget_id, payeeId, patch.account_id ?? existing.account_id);
        if (transferPeer && (subtransactions?.length ?? 0) > 0) throw new HttpError(400, 'a transfer cannot be split', 'transfer_cannot_be_split');
      }
      set.push({ col: 'payee_id', value: payeeId });
    }
  }

  // Splits save full-leg lists (syscd-app-rlt): replace, don't diff. Split
  // edits force the parent category to NULL ("Split"); saving without legs
  // on a former split clears the stale NULL category so the row is not
  // silently uncategorized.
  if (subtransactions !== undefined) {
    const isSplit = subtransactions.length > 0;
    if (isSplit) {
      if (!set.some((e) => 'col' in e && e.col === 'category_id')) {
        set.push({ col: 'category_id', value: null });
      }
    } else if (existingCategory !== null && patch.category_id === undefined) {
      set.push({ col: 'category_id', value: await suggestedCategoryForPayee(client, budget_id, existingPayeeId) });
    }
  }
  await txnStore.updateTransactionSet(client, id, set);
  if (subtransactions !== undefined) {
    await txnStore.softDeleteSubtransactionsOf(client, id);
    if (subtransactions.length > 0) {
      await insertSubTxns(client, budget_id, id, subtransactions);
    }
  }

  // Keep the transfer's other leg in step: created when the payee became a
  // transfer payee, removed when it stopped being one, otherwise amount /
  // date / memo / account follow the edit. Returns the MIRROR's deltas only.
  const mirrorDeltas =
    payeeChanged || existing.transfer_transaction_id
      ? await syncMirror(client, budget_id, id, payeeChanged ? (transferPeer?.accountId ?? null) : undefined)
      : [];

  // Derived from the row before/after the edit.
  const after = await txnStore.getLedgerRow(client, id);
  await applyBalanceDeltas(client, budget_id, [...deriveDeltas(existing, after ?? null), ...mirrorDeltas]);
}
