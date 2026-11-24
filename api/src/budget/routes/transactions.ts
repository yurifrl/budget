import type { z } from '@shared/zod';

import { pool, withTransaction } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  transactionAdd,
  transactionsBulk,
  transactionsCreate,
  transactionsDelete,
  transactionsGet,
  transactionsList,
  transactionsUpdate,
} from '@shared/contracts/budget';
import { suggestedCategoryForPayee } from '../domain/categorization';
import { ONE_WAY_ERROR, bothPositive, type createTxnSchema, type subTxnListSchema } from '@shared/contracts/budget/schemas';
import {
  applyBalanceDeltas,
  deriveDeltas,
  type BalanceDelta,
  insertSubTxns,
  loadRenameRules,
  resolvePayeeId,
  upsertPayee,
} from '../domain/transactions';
import { linkTransfers, transferOverview } from '../domain/transfer-links';
import { deleteMirror, insertMirror, resolveTransferPeer, syncMirror } from '../domain/transfers';
import { advanceOccurrence } from '../domain/repeat-schedule';
import { applyRules } from '@shared/domain/payees';
import { getImportMetadata, listInstallmentSources } from '../../connections';
import { upcomingInstallmentRows } from '../domain/upcoming-installments';
import { budgetRouter } from '../router';
import { findAccountInBudget } from '../store/accounts';
import { categoryInBudget } from '../store/categories';
import { getRepeatRuleSchedule, skipRepeatRulePast } from '../store/repeat-rules';
import * as txnStore from '../store/transactions';

type CreateTxn = z.output<typeof createTxnSchema>;

/** `YYYY-MM-DD` of a list row's date (pg hands DATE columns over as a Date). */
const dateOf = (d: unknown): string => (d instanceof Date ? d.toISOString() : String(d)).slice(0, 10);

/** Insert one transaction (+ split legs / transfer mirror) and apply balance deltas, atomically. */
async function createTransaction(
  budget_id: string,
  txn: CreateTxn,
  subtransactions: z.output<typeof subTxnListSchema> | undefined,
) {
  return withTransaction(pool, async (client) => {
    // Referenced account/category must belong to this budget; otherwise the
    // insert would silently create a cross-budget transaction.
    const acc = await findAccountInBudget(client, txn.account_id, budget_id);
    if (!acc) throw new HttpError(400, 'account not found in budget', 'account_not_in_budget');
    // Closed accounts are immutable — no new transactions (YNAB parity).
    if (acc.closed) throw new HttpError(409, 'account is closed', 'account_closed');
    if (txn.category_id) {
      if (!(await categoryInBudget(client, txn.category_id, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
    }
    const payeeId = await resolvePayeeId(client, budget_id, txn.payee);
    // A split overrides the single category: the parent carries NULL ("Split")
    // and each leg owns its own category (syscd-app-rlt).
    const isSplit = (subtransactions?.length ?? 0) > 0;
    if (isSplit && txn.category_id) throw new HttpError(400, 'split transactions cannot carry a category_id', 'split_cannot_have_category');
    // A transfer payee makes this row one leg of a transfer (mirror created
    // below); money moving between two on-budget accounts carries no category.
    const peer = await resolveTransferPeer(client, budget_id, payeeId, txn.account_id);
    if (peer && isSplit) throw new HttpError(400, 'a transfer cannot be split', 'transfer_cannot_be_split');
    // Auto-categorization: an explicitly sent category always wins; otherwise
    // the payee's categorization mode decides what, if anything, is preselected.
    const categoryId = isSplit || peer?.internal
      ? null
      : (txn.category_id ?? (await suggestedCategoryForPayee(client, budget_id, payeeId)));
    // Split rows ignore the client amount: the signed parent amount is the
    // sum of legs, computed server-side so the register total can't drift.
    const amount = isSplit
      ? subtransactions!.reduce((sum, s) => sum + s.inflow - s.outflow, 0)
      : txn.inflow - txn.outflow;
    const inserted = await txnStore.insertTransaction(client, {
      budgetId: budget_id,
      accountId: txn.account_id,
      date: txn.date,
      // inflow/outflow and storage are both milliunits.
      amount,
      payeeId,
      categoryId,
      memo: txn.memo || null,
      cleared: txn.cleared,
      approved: txn.approved,
      flag: txn.flag,
      repeat: txn.repeat,
    });
    if (subtransactions && subtransactions.length > 0) {
      await insertSubTxns(client, budget_id, inserted.id, subtransactions);
    }
    // Balance deltas are ALWAYS server-derived (the mirror leg's included);
    // both go through one applyBalanceDeltas.
    let created = inserted;
    let mirrorDeltas: BalanceDelta[] = [];
    if (peer) {
      mirrorDeltas = (await insertMirror(client, budget_id, created, peer.accountId)).deltas;
      created = await txnStore.getTransaction(client, created.id);
    }
    // Derived from the row as stored.
    await applyBalanceDeltas(client, budget_id, [
      ...deriveDeltas(null, { account_id: txn.account_id, amount: inserted.amount, cleared: txn.cleared }),
      ...mirrorDeltas,
    ]);
    return created;
  });
}

export const operations = [
  implement(transactionsList, async (_c, { budget_id: budgetId }) => {
    const rows = await txnStore.listLiveTransactions(pool, budgetId);
    // Splits ride along (syscd-app-rlt): one subtransactions query per budget,
    // grouped client-side by transaction_id.
    const subs = await txnStore.listLiveSubtransactions(pool, budgetId);
    const byTxn = new Map<string, unknown[]>();
    for (const row of subs) {
      const list = byTxn.get(row.transaction_id) ?? [];
      list.push(row);
      byTxn.set(row.transaction_id, list);
    }
    // Transfer matcher view (budget-mit6): suggestion icon, pending rule rows, who linked.
    const transfers = await transferOverview(pool, budgetId);
    const stored = rows.map((t) => {
      const s = transfers.rows.get(t.id);
      return {
        ...t,
        subtransactions: byTxn.get(t.id) ?? [],
        transfer_suggestion: s
          ? { confidence: s.confidence, candidate_count: s.candidateCount, counterpart_id: s.counterpartId }
          : null,
        transfer_pending: transfers.pending.get(t.id) ?? null,
        transfer_link_method: t.transfer_transaction_id ? (transfers.methods.get(t.id) ?? null) : null,
      };
    });
    // Card installments the bank has not billed yet: derived per read, never
    // stored (see domain/upcoming-installments), merged newest first.
    const upcoming = upcomingInstallmentRows(await listInstallmentSources(pool, budgetId));
    if (upcoming.length === 0) return stored;
    return [...upcoming.reverse(), ...stored].sort((a, b) => dateOf(b.date).localeCompare(dateOf(a.date)));
  }),

  // Detail read: the row is re-scoped by budget_id in SQL before its import
  // record (keyed by transaction id only) is read.
  implement(transactionsGet, async (_c, { id, budget_id: budgetId }) => {
    const row = await txnStore.getTransactionDetailInBudget(pool, id, budgetId);
    if (!row) throw new HttpError(404, 'transaction not found');
    const [subtransactions, meta] = await Promise.all([
      txnStore.listTransactionSubtransactions(pool, id, budgetId),
      getImportMetadata(pool, id),
    ]);
    const { account_connection_id: connectionId, account_institution: bankName, ...transaction } = row;
    return {
      transaction: { ...transaction, subtransactions },
      import: meta
        ? {
            provider: meta.provider,
            bank_transaction_id: meta.externalTransactionId,
            connection_id: connectionId,
            bank_name: bankName,
            state: meta.blocked ? ('edited' as const) : ('imported' as const),
            last_synced_payload: meta.lastSyncedPayload,
            raw: meta.raw,
            raw_received_at: meta.rawReceivedAt?.toISOString() ?? null,
            updated_at: meta.updatedAt.toISOString(),
          }
        : null,
    };
  }),

  implement(transactionsCreate, (_c, { budget_id, txn, subtransactions }) =>
    createTransaction(budget_id, txn, subtransactions),
  ),

  // Agent-friendly add: flat input, payee by NAME, one signed amount; the same
  // create path (ownership, payee resolution, auto-category, derived deltas).
  implement(transactionAdd, (_c, input) =>
    createTransaction(
      input.budget_id,
      {
        account_id: input.account_id,
        date: input.date ?? new Date().toISOString().slice(0, 10),
        payee: input.payee,
        category_id: input.category_id ?? null,
        memo: input.memo ?? null,
        outflow: input.amount < 0 ? -input.amount : 0,
        inflow: input.amount > 0 ? input.amount : 0,
        cleared: input.cleared ?? 'uncleared',
        approved: true,
        flag: null,
        repeat: 'never',
      },
      undefined,
    ),
  ),

  /**
   * POST /bulk — one statement-import batch for a single account.
   *
   * The client sends parsed rows (milliunits) and nothing else: the server resolves
   * payees (once per distinct name, rename rules applied), dedupes on YNAB-style
   * import_ids (exact match for rows that carry one; generated
   * `YNAB:<milliunits>:<date>:<payee>:<occurrence>` ids for rows that don't —
   * the idempotency key is the (date, payee, signed amount) triple, and the
   * occurrence only separates rows whose whole key is identical), computes
   * the single account balance delta itself, and stores every imported row
   * uncleared + unapproved so it surfaces in the review flow.
   */
  implement(transactionsBulk, async (_c, { budget_id, account_id, txns }) => {
    return withTransaction(pool, async (client) => {
      // Referenced account must belong to this budget; otherwise the insert
      // would silently create a cross-budget transaction.
      const acc = await findAccountInBudget(client, account_id, budget_id);
      if (!acc) throw new HttpError(400, 'account not found in budget', 'account_not_in_budget');
      // Closed accounts are immutable — no new transactions (YNAB parity).
      if (acc.closed) throw new HttpError(409, 'account is closed', 'account_closed');
      const categoryIds = new Set<string>();
      for (const txn of txns) {
        if (txn.category_id) categoryIds.add(txn.category_id);
      }
      for (const categoryId of categoryIds) {
        if (!(await categoryInBudget(client, categoryId, budget_id))) throw new HttpError(400, 'category not found in budget', 'category_not_in_budget');
      }

      const rules = (await loadRenameRules(client, budget_id)).rows;
      const payeeIdByName = new Map<string, string | null>();
      for (const name of new Set(txns.map((t) => t.payee.trim()).filter(Boolean))) {
        payeeIdByName.set(name, await upsertPayee(client, budget_id, applyRules(rules, name)));
      }

      // Existing occurrence numbers per `YNAB:<milliunits>:<date>:<payee>`
      // prefix so id-less rows can follow YNAB's duplicate rule. Uniqueness is
      // the (date, payee, signed amount) triple — two vendors charging the same
      // amount on the same day are distinct rows — and the occurrence number
      // only breaks ties between rows whose whole key is identical (same
      // vendor, same day, same amount, charged twice). An incoming row whose
      // occurrence is <= an existing one for the same prefix is a re-import of
      // that row, not a new transaction.
      const payeeKeyOf = (txn: (typeof txns)[number]) => payeeIdByName.get(txn.payee.trim()) ?? '-';
      const prefixes = [
        ...new Set(
          txns
            .filter((t) => !t.import_id)
            .map((t) => `YNAB:${t.inflow - t.outflow}:${t.date}:${payeeKeyOf(t)}`),
        ),
      ];
      const existingOccs = new Map<string, number[]>();
      if (prefixes.length > 0) {
        const found = await txnStore.findImportIdsLike(
          client,
          account_id,
          prefixes.map((prefix) => `${prefix}:%`),
        );
        for (const import_id of found) {
          const cut = import_id.lastIndexOf(':');
          const occ = Number(import_id.slice(cut + 1));
          const prefix = import_id.slice(0, cut);
          if (prefixes.includes(prefix) && Number.isInteger(occ)) {
            const occs = existingOccs.get(prefix) ?? [];
            occs.push(occ);
            existingOccs.set(prefix, occs);
          }
        }
      }

      let imported = 0;
      let duplicates = 0;
      let unclearedDelta = 0; // milliunits, summed across inserted rows
      const batchOcc = new Map<string, number>();
      for (const txn of txns) {
        const milliunits = txn.inflow - txn.outflow;
        let importId = txn.import_id ?? null;
        if (!importId) {
          const prefix = `YNAB:${milliunits}:${txn.date}:${payeeKeyOf(txn)}`;
          const occ = (batchOcc.get(prefix) ?? 0) + 1;
          batchOcc.set(prefix, occ);
          if ((existingOccs.get(prefix) ?? []).some((existing) => existing <= occ)) {
            duplicates += 1;
            continue;
          }
          importId = `${prefix}:${occ}`;
        }
        const inserted = await txnStore.insertBulkImportRow(client, {
          budgetId: budget_id,
          accountId: account_id,
          date: txn.date,
          amount: milliunits,
          payeeId: payeeIdByName.get(txn.payee.trim()) ?? null,
          categoryId: txn.category_id,
          memo: txn.memo || null,
          importId,
          importPayeeName: txn.import_payee_name ?? txn.payee,
          importPayeeNameOriginal: txn.import_payee_name_original ?? txn.payee,
        });
        if (!inserted) {
          // Exact import_id already present among live rows -> duplicate.
          duplicates += 1;
          continue;
        }
        imported += 1;
        unclearedDelta += milliunits;
      }

      // One server-computed delta for the whole batch — clients never send
      // balance math for imports.
      if (imported > 0) {
        await applyBalanceDeltas(client, budget_id, [
          { account_id, cleared_delta: 0, uncleared_delta: unclearedDelta },
        ]);
      }
      // Imported rows that pair with another own account's row become transfers.
      if (imported > 0) await linkTransfers(client, budget_id);
      return { imported, duplicates };
    });
  }),

  implement(transactionsUpdate, async (_c, { id, budget_id, patch, subtransactions }) => {
    if (bothPositive({ inflow: patch.inflow ?? 0, outflow: patch.outflow ?? 0 })) {
      throw new HttpError(400, ONE_WAY_ERROR);
    }
    return withTransaction(pool, async (client) => {

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
      if (patch.payee !== undefined) {
        const payeeId = await resolvePayeeId(client, budget_id, patch.payee);
        if (payeeId !== existingPayeeId) {
          payeeChanged = true;
          transferPeer = await resolveTransferPeer(client, budget_id, payeeId, patch.account_id ?? existing.account_id);
          if (transferPeer && (subtransactions?.length ?? 0) > 0) throw new HttpError(400, 'a transfer cannot be split', 'transfer_cannot_be_split');
        }
        set.push({ col: 'payee_id', value: payeeId });
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
    });
  }),

  implement(transactionsDelete, async (_c, { id, budget_id: budgetId }) => {
    // Deleting must move the account balances too: the server derives the
    // reversal from the deleted row.
    // Soft-delete scoped to the budget; 404 rather than a silent no-op on a
    // foreign or already-deleted row.
    return withTransaction(pool, async (client) => {
      const deleted = await txnStore.softDeleteTransactionInBudget(client, id, budgetId);
      if (!deleted) {
        throw new HttpError(404, 'transaction not found');
      }
      // Deleting a pending upcoming occurrence must not resurrect it: the
      // partial unique index ignores deleted rows, so skip the rule past the
      // occurrence — otherwise the next generation run re-materializes it.
      if (deleted.upcoming && deleted.repeat_rule_id && deleted.occurrence_date) {
        const rule = await getRepeatRuleSchedule(client, deleted.repeat_rule_id);
        if (rule) {
          const after = advanceOccurrence(deleted.occurrence_date, rule.frequency, rule.month_last_day);
          await skipRepeatRulePast(client, deleted.repeat_rule_id, after);
        }
      }
      // Reverse the row's effect — except a pending upcoming
      // occurrence, whose balance delta was withheld and so has nothing to undo.
      // Deleting one side of a transfer deletes the other; its reversal is
      // server-derived like every mirror delta.
      const mirrorDeltas = deleted.transfer_transaction_id
        ? await deleteMirror(client, budgetId, deleted.transfer_transaction_id)
        : [];
      await applyBalanceDeltas(client, budgetId, [
        ...(deleted.upcoming ? [] : deriveDeltas(deleted, null)),
        ...mirrorDeltas,
      ]);
    });
  }),
];

export default budgetRouter('/transactions', operations);
