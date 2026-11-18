import type { z } from '@shared/zod';

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import {
  transactionAdd,
  transactionsBulk,
  transactionsCreate,
  transactionsDelete,
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
  type LedgerRow,
} from '../domain/transactions';
import { linkCardPayments } from '../domain/card-payments';
import { deleteMirror, insertMirror, resolveTransferPeer, syncMirror } from '../domain/transfers';
import { advanceOccurrence, type RepeatFrequency } from '../domain/repeat-schedule';
import { applyRules } from '@shared/domain/payees';
import { budgetRouter } from '../router';

type CreateTxn = z.output<typeof createTxnSchema>;

/** Insert one transaction (+ split legs / transfer mirror) and apply balance deltas, atomically. */
async function createTransaction(
  budget_id: string,
  txn: CreateTxn,
  subtransactions: z.output<typeof subTxnListSchema> | undefined,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Referenced account/category must belong to this budget; otherwise the
    // insert would silently create a cross-budget transaction.
    const accCheck = await client.query<{ closed: boolean }>(
      'SELECT closed FROM accounts WHERE id = $1 AND budget_id = $2',
      [txn.account_id, budget_id],
    );
    if (accCheck.rowCount === 0) throw new HttpError(400, 'account not found in budget');
    // Closed accounts are immutable — no new transactions (YNAB parity).
    if (accCheck.rows[0].closed) throw new HttpError(409, 'account is closed');
    if (txn.category_id) {
      const catCheck = await client.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [
        txn.category_id,
        budget_id,
      ]);
      if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget');
    }
    const payeeId = await resolvePayeeId(client, budget_id, txn.payee);
    // A split overrides the single category: the parent carries NULL ("Split")
    // and each leg owns its own category (syscd-app-rlt).
    const isSplit = (subtransactions?.length ?? 0) > 0;
    if (isSplit && txn.category_id) throw new HttpError(400, 'split transactions cannot carry a category_id');
    // A transfer payee makes this row one leg of a transfer (mirror created
    // below); money moving between two on-budget accounts carries no category.
    const peer = await resolveTransferPeer(client, budget_id, payeeId, txn.account_id);
    if (peer && isSplit) throw new HttpError(400, 'a transfer cannot be split');
    // Auto-categorization: an explicitly sent category always wins; otherwise
    // the payee's categorization mode decides what, if anything, is preselected.
    const categoryId = isSplit || peer?.internal
      ? null
      : (txn.category_id ?? (await suggestedCategoryForPayee(client, budget_id, payeeId)));
    // Split rows ignore the client amount: the signed parent amount is the
    // sum of legs, computed server-side so the register total can't drift.
    const amount = isSplit
      ? subtransactions!.reduce((sum, s) => sum + s.inflow_cents - s.outflow_cents, 0) * 10
      : (txn.inflow_cents - txn.outflow_cents) * 10;
    const result = await client.query(
      `INSERT INTO transactions
      (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, flag_color, flag_name, repeat, deleted)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $11, false)
     RETURNING *`,
      [
        budget_id,
        txn.account_id,
        txn.date,
        // client sends inflow/outflow in cents; storage is milliunits.
        amount,
        payeeId,
        categoryId,
        txn.memo || null,
        txn.cleared,
        txn.approved,
        txn.flag,
        txn.repeat,
      ],
    );
    if (subtransactions && subtransactions.length > 0) {
      await insertSubTxns(client, budget_id, result.rows[0].id, subtransactions);
    }
    // Balance deltas are ALWAYS server-derived (the mirror leg's included);
    // both go through one applyBalanceDeltas.
    let created = result.rows[0];
    let mirrorDeltas: BalanceDelta[] = [];
    if (peer) {
      mirrorDeltas = (await insertMirror(client, budget_id, created, peer.accountId)).deltas;
      created = (await client.query('SELECT * FROM transactions WHERE id = $1', [created.id])).rows[0];
    }
    // Derived from the row as stored.
    await applyBalanceDeltas(client, budget_id, [
      ...deriveDeltas(null, { account_id: txn.account_id, amount: result.rows[0].amount, cleared: txn.cleared }),
      ...mirrorDeltas,
    ]);
    await client.query('COMMIT');
    return created;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export const operations = [
  implement(transactionsList, async (_c, { budget_id: budgetId }) => {
    const result = await pool.query(
      // payee_name rides along because GET /payees deliberately omits transfer
      // payees ("Transfer : <account>"), so the client cannot resolve payee_id
      // for transfer legs from that list (backup export lost them).
      `SELECT t.*, p.name AS payee_name
     FROM transactions t
     LEFT JOIN payees p ON p.id = t.payee_id
     WHERE t.budget_id = $1 AND t.deleted = false
     ORDER BY t.date DESC, t.created_at DESC, t.id`,
      [budgetId],
    );
    // Splits ride along (syscd-app-rlt): one subtransactions query per budget,
    // grouped client-side by transaction_id.
    const subs = await pool.query(
      `SELECT id, transaction_id, amount, memo, payee_id, category_id,
            transfer_account_id, transfer_transaction_id, deleted
     FROM subtransactions
     WHERE budget_id = $1 AND deleted = false
     ORDER BY created_at, id`,
      [budgetId],
    );
    const byTxn = new Map<string, unknown[]>();
    for (const row of subs.rows) {
      const list = byTxn.get(row.transaction_id) ?? [];
      list.push(row);
      byTxn.set(row.transaction_id, list);
    }
    return result.rows.map((t) => ({ ...t, subtransactions: byTxn.get(t.id) ?? [] }));
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
        outflow_cents: input.amount_cents < 0 ? -input.amount_cents : 0,
        inflow_cents: input.amount_cents > 0 ? input.amount_cents : 0,
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
   * The client sends parsed rows (cents) and nothing else: the server resolves
   * payees (once per distinct name, rename rules applied), dedupes on YNAB-style
   * import_ids (exact match for rows that carry one; generated
   * `YNAB:<milliunits>:<date>:<payee>:<occurrence>` ids for rows that don't —
   * the idempotency key is the (date, payee, signed amount) triple, and the
   * occurrence only separates rows whose whole key is identical), computes
   * the single account balance delta itself, and stores every imported row
   * uncleared + unapproved so it surfaces in the review flow.
   */
  implement(transactionsBulk, async (_c, { budget_id, account_id, txns }) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Referenced account must belong to this budget; otherwise the insert
      // would silently create a cross-budget transaction.
      const accCheck = await client.query<{ closed: boolean }>(
        'SELECT closed FROM accounts WHERE id = $1 AND budget_id = $2',
        [account_id, budget_id],
      );
      if (accCheck.rowCount === 0) throw new HttpError(400, 'account not found in budget');
      // Closed accounts are immutable — no new transactions (YNAB parity).
      if (accCheck.rows[0].closed) throw new HttpError(409, 'account is closed');
      const categoryIds = new Set<string>();
      for (const txn of txns) {
        if (txn.category_id) categoryIds.add(txn.category_id);
      }
      for (const categoryId of categoryIds) {
        const catCheck = await client.query('SELECT 1 FROM categories WHERE id = $1 AND budget_id = $2', [
          categoryId,
          budget_id,
        ]);
        if (catCheck.rowCount === 0) throw new HttpError(400, 'category not found in budget');
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
            .map((t) => `YNAB:${(t.inflow_cents - t.outflow_cents) * 10}:${t.date}:${payeeKeyOf(t)}`),
        ),
      ];
      const existingOccs = new Map<string, number[]>();
      if (prefixes.length > 0) {
        const found = await client.query<{ import_id: string }>(
          // Prefix chars are digits/-/: so the only LIKE wildcard is the % suffix.
          'SELECT import_id FROM transactions WHERE account_id = $1 AND NOT deleted AND import_id LIKE ANY($2::text[])',
          [account_id, prefixes.map((prefix) => `${prefix}:%`)],
        );
        for (const { import_id } of found.rows) {
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
      let unclearedDelta = 0; // cents, summed across inserted rows
      const batchOcc = new Map<string, number>();
      for (const txn of txns) {
        const milliunits = (txn.inflow_cents - txn.outflow_cents) * 10;
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
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO transactions
          (budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved,
           flag_color, flag_name, repeat, deleted, import_id, import_payee_name, import_payee_name_original)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'uncleared', false, NULL, NULL, 'never', false, $8, $9, $10)
         ON CONFLICT (account_id, import_id) WHERE import_id IS NOT NULL AND NOT deleted
         DO NOTHING
         RETURNING id`,
          [
            budget_id,
            account_id,
            txn.date,
            milliunits,
            payeeIdByName.get(txn.payee.trim()) ?? null,
            txn.category_id,
            txn.memo || null,
            importId,
            txn.import_payee_name ?? txn.payee,
            txn.import_payee_name_original ?? txn.payee,
          ],
        );
        if (inserted.rowCount === 0) {
          // Exact import_id already present among live rows -> duplicate.
          duplicates += 1;
          continue;
        }
        imported += 1;
        unclearedDelta += txn.inflow_cents - txn.outflow_cents;
      }

      // One server-computed delta for the whole batch — clients never send
      // balance math for imports.
      if (imported > 0) {
        await applyBalanceDeltas(client, budget_id, [
          { account_id, cleared_delta: 0, uncleared_delta: unclearedDelta },
        ]);
      }
      // Imported statement payments (cash outflow + card inflow) become transfers.
      if (imported > 0) await linkCardPayments(client, budget_id);
      await client.query('COMMIT');
      return { imported, duplicates };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),

  implement(transactionsUpdate, async (_c, { id, budget_id, patch, subtransactions }) => {
    if (bothPositive({ inflow_cents: patch.inflow_cents ?? 0, outflow_cents: patch.outflow_cents ?? 0 })) {
      throw new HttpError(400, ONE_WAY_ERROR);
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // The transaction must exist, belong to this budget, and not be deleted;
      // otherwise the update would silently mutate another budget's row.
      const owned = await client.query<{
        repeat_rule_id: string | null;
        occurrence_date: string | null;
        upcoming: boolean;
        account_id: string;
        amount: string;
        cleared: LedgerRow['cleared'];
        payee_id: string | null;
        category_id: string | null;
        transfer_transaction_id: string | null;
      }>(
        'SELECT repeat_rule_id, occurrence_date, upcoming, account_id, amount, cleared, payee_id, category_id, transfer_transaction_id FROM transactions WHERE id = $1 AND budget_id = $2 AND deleted = false',
        [id, budget_id],
      );
      if (owned.rowCount === 0) throw new HttpError(404, 'transaction not found');
      const existing = owned.rows[0];
      const existingPayeeId = existing.payee_id;
      const existingCategory = existing.category_id;
      if (patch.account_id !== undefined) {
        const accCheck = await client.query<{ closed: boolean }>(
          'SELECT closed FROM accounts WHERE id = $1 AND budget_id = $2',
          [patch.account_id, budget_id],
        );
        if (accCheck.rowCount === 0) throw new HttpError(400, 'account not found in budget');
        // Closed accounts are immutable — no moving rows into them (YNAB parity).
        if (accCheck.rows[0].closed) throw new HttpError(409, 'account is closed');
      }
      if (patch.category_id && (subtransactions?.length ?? 0) > 0) {
        throw new HttpError(400, 'split transactions cannot carry a category_id');
      }

      const setCols: string[] = [];
      const values: unknown[] = [];
      let idx = 1;

      if (patch.account_id !== undefined) {
        setCols.push(`account_id = $${idx++}`);
        values.push(patch.account_id);
      }
      if (patch.date !== undefined) {
        setCols.push(`date = $${idx++}`);
        values.push(patch.date);
      }
      if (patch.category_id !== undefined) {
        setCols.push(`category_id = $${idx++}`);
        values.push(patch.category_id);
      }
      if (patch.memo !== undefined) {
        setCols.push(`memo = $${idx++}`);
        values.push(patch.memo || null);
      }
      if (patch.cleared !== undefined) {
        setCols.push(`cleared = $${idx++}`);
        values.push(patch.cleared);
      }
      if (patch.approved !== undefined) {
        setCols.push(`approved = $${idx++}`);
        values.push(patch.approved);
      }
      if (patch.flag !== undefined) {
        setCols.push(`flag_color = $${idx++}`);
        values.push(patch.flag);
      }
      if (patch.repeat !== undefined) {
        setCols.push(`repeat = $${idx++}`);
        values.push(patch.repeat);
      }
      // Match/unmatch (syscd-app-42f): both sides of a matched pair store the
      // same linked id; unmatch clears both. No FK check — the counterpart is
      // validated client-side and scoped by budget_id on read.
      if (patch.matched_transaction_id !== undefined) {
        setCols.push(`matched_transaction_id = $${idx++}`);
        values.push(patch.matched_transaction_id);
      }
      if (patch.outflow_cents !== undefined || patch.inflow_cents !== undefined) {
        const amount = ((patch.inflow_cents ?? 0) - (patch.outflow_cents ?? 0)) * 10;
        setCols.push(`amount = $${idx++}`);
        values.push(amount);
      }

      // Editing a pending upcoming occurrence of a repeat rule detaches it:
      // YNAB turns the future instance into a free-standing transaction and
      // the rule's next_due_date skips past the occurrence instead. The
      // withheld balance delta is applied as part of the flip (the client's
      // edit delta then re-balances the edited amounts on top).
      if (Object.keys(patch).length > 0 && existing.upcoming && existing.repeat_rule_id) {
        setCols.push('repeat_rule_id = NULL', 'occurrence_date = NULL', 'upcoming = false');
        await applyBalanceDeltas(client, budget_id, [
          {
            account_id: existing.account_id,
            cleared_delta: 0,
            uncleared_delta: Number(existing.amount) / 10,
          },
        ]);
        const rule = await client.query<{ frequency: RepeatFrequency; month_last_day: boolean }>(
          'SELECT frequency, month_last_day FROM txn_repeat_rules WHERE id = $1',
          [existing.repeat_rule_id],
        );
        if (rule.rows[0] && existing.occurrence_date) {
          const after = advanceOccurrence(
            existing.occurrence_date,
            rule.rows[0].frequency,
            rule.rows[0].month_last_day,
          );
          await client.query(
            'UPDATE txn_repeat_rules SET next_due_date = GREATEST(next_due_date, $1::date) WHERE id = $2',
            [after, existing.repeat_rule_id],
          );
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
          if (transferPeer && (subtransactions?.length ?? 0) > 0) throw new HttpError(400, 'a transfer cannot be split');
        }
        setCols.push(`payee_id = $${idx++}`);
        values.push(payeeId);
      }

      // Splits save full-leg lists (syscd-app-rlt): replace, don't diff. Split
      // edits force the parent category to NULL ("Split"); saving without legs
      // on a former split clears the stale NULL category so the row is not
      // silently uncategorized.
      if (subtransactions !== undefined) {
        const isSplit = subtransactions.length > 0;
        if (isSplit) {
          if (!setCols.some((c) => c.startsWith('category_id'))) {
            setCols.push(`category_id = $${idx++}`);
            values.push(null);
          }
        } else if (existingCategory !== null && patch.category_id === undefined) {
          setCols.push(`category_id = $${idx++}`);
          values.push(await suggestedCategoryForPayee(client, budget_id, existingPayeeId));
        }
      }
      if (setCols.length > 0) {
        values.push(id);
        await client.query(`UPDATE transactions SET ${setCols.join(', ')} WHERE id = $${idx}`, values);
      }
      if (subtransactions !== undefined) {
        await client.query('UPDATE subtransactions SET deleted = true WHERE transaction_id = $1', [id]);
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
      const after = await client.query<LedgerRow>(
        'SELECT account_id, amount, cleared FROM transactions WHERE id = $1',
        [id],
      );
      await applyBalanceDeltas(client, budget_id, [...deriveDeltas(existing, after.rows[0] ?? null), ...mirrorDeltas]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),

  implement(transactionsDelete, async (_c, { id, budget_id: budgetId }) => {
    // Deleting must move the account balances too: the server derives the
    // reversal from the deleted row.
    // Soft-delete scoped to the budget; 404 rather than a silent no-op on a
    // foreign or already-deleted row.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<
        {
          repeat_rule_id: string | null;
          occurrence_date: string | null;
          upcoming: boolean;
          transfer_transaction_id: string | null;
        } & LedgerRow
      >(
        'UPDATE transactions SET deleted = true WHERE id = $1 AND budget_id = $2 AND deleted = false RETURNING repeat_rule_id, occurrence_date, upcoming, account_id, amount, cleared, transfer_transaction_id',
        [id, budgetId],
      );
      if (result.rowCount === 0) {
        await client.query('ROLLBACK');
        throw new HttpError(404, 'transaction not found');
      }
      // Deleting a pending upcoming occurrence must not resurrect it: the
      // partial unique index ignores deleted rows, so skip the rule past the
      // occurrence — otherwise the next generation run re-materializes it.
      const deleted = result.rows[0];
      if (deleted.upcoming && deleted.repeat_rule_id && deleted.occurrence_date) {
        const rule = await client.query<{ frequency: RepeatFrequency; month_last_day: boolean }>(
          'SELECT frequency, month_last_day FROM txn_repeat_rules WHERE id = $1',
          [deleted.repeat_rule_id],
        );
        if (rule.rows[0]) {
          const after = advanceOccurrence(deleted.occurrence_date, rule.rows[0].frequency, rule.rows[0].month_last_day);
          await client.query(
            'UPDATE txn_repeat_rules SET next_due_date = GREATEST(next_due_date, $1::date) WHERE id = $2',
            [after, deleted.repeat_rule_id],
          );
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
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }),
];

export default budgetRouter('/transactions', operations);
