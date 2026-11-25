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
  resolveStatementPayee,
  resolvePayeeId,
  type StatementPayee,
} from '../domain/transactions';
import { linkTransfers, transferOverview } from '../domain/transfer-links';
import { setTransferHint } from '../store/transfers';
import { payeeIdFromRequest } from '../domain/edited-payee';
import { insertMirror, removeMirror, resolveTransferPeer } from '../domain/transfers';
import { advanceOccurrence } from '../domain/repeat-schedule';
import { updateTransactionInClient } from '../domain/transaction-update';
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
    const payeeId =
      txn.payee_id !== undefined ? await payeeIdFromRequest(client, budget_id, txn.payee_id) : await resolvePayeeId(client, budget_id, txn.payee);
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

      const rules = await loadRenameRules(client, budget_id);
      // A renaming rule that matches ASSIGNS its payee. A text that names an account's
      // transfer payee (through a rule or as text) does NOT store that payee (a payee-only
      // half transfer): the row stays ordinary and the account is remembered as a hint for
      // the matcher (see planImportedPayee). Payees are created only for rows that are
      // inserted (resolveStatementPayee).
      // A row whose `import_payee_name_original` (the statement text as parsed) differs from `payee` carries a
      // payee the person CHOSE in the import screen (the released client sends the chosen payee's name as `payee`):
      // rules apply to bank text only, never to a chosen payee. Main did not tell them apart (it ran every `payee`
      // through the rules); this is the one signal the request has.
      const isChosen = (t: (typeof txns)[number]) => t.import_payee_name_original !== undefined && t.import_payee_name_original.trim() !== t.payee.trim();
      const payeeKeyOfText = (t: (typeof txns)[number]) => `${isChosen(t) ? 'chosen' : 'text'}\0${t.payee.trim()}`;
      const payeeByName = new Map<string, StatementPayee>();
      for (const t of txns) {
        const name = t.payee.trim();
        const key = payeeKeyOfText(t);
        if (name && !payeeByName.has(key)) payeeByName.set(key, await resolveStatementPayee(client, budget_id, name, rules, { chosen: isChosen(t) }));
      }

      // Existing occurrence numbers per `YNAB:<milliunits>:<date>:<payee>`
      // prefix so id-less rows can follow YNAB's duplicate rule. Uniqueness is
      // the (date, payee, signed amount) triple — two vendors charging the same
      // amount on the same day are distinct rows — and the occurrence number
      // only breaks ties between rows whose whole key is identical (same
      // vendor, same day, same amount, charged twice). An incoming row whose
      // occurrence is <= an existing one for the same prefix is a re-import of
      // that row, not a new transaction.
      // The key keeps counting under the account's transfer payee for such text,
      // as before: re-importing a file stays idempotent across this change. A file
      // imported while a `contains` rule still spliced its payee into the text counted
      // under that spliced payee: its keys are looked up too (read only), so those rows
      // are still the same rows. Only the FIRST key is written for a new row.
      // The ids the stored rows of a text count under (read only: no payee is created to look rows up):
      // the payee's own id when it exists, plus every id the text counted under before a matching rule assigned its payee.
      const lookupKeysByName = new Map<string, { current: string | null; earlier: string[]; countKey: string }>();
      const keysOf = async (txn: (typeof txns)[number]) => {
        const name = payeeKeyOfText(txn);
        let keys = lookupKeysByName.get(name);
        if (!keys) {
          const p = payeeByName.get(name);
          const current = p ? await p.existingKey() : null;
          keys = {
            current: current === undefined ? null : (current ?? '-'),
            earlier: [...new Set((await p?.earlierKeys()) ?? [])],
            // What the row counts under in this batch: the id when the payee exists, else its name (the payee is created with its first row).
            countKey: current === undefined ? `new:${p?.plan.ordinaryName ?? ''}` : (current ?? '-'),
          };
          lookupKeysByName.set(name, keys);
        }
        return keys;
      };
      const lookupKeysOf = async (txn: (typeof txns)[number]) => {
        const k = await keysOf(txn);
        return [...(k.current === null ? [] : [k.current]), ...k.earlier];
      };
      const prefixOf = (txn: (typeof txns)[number], key: string) => `YNAB:${txn.inflow - txn.outflow}:${txn.date}:${key}`;
      const prefixes: string[] = [];
      for (const t of txns) {
        if (!t.import_id) for (const key of await lookupKeysOf(t)) if (!prefixes.includes(prefixOf(t, key))) prefixes.push(prefixOf(t, key));
      }
      // The stored rows of each prefix: their occurrence number and the statement text they came from. An incoming row is a
      // re-import of a stored one only when the text is the same (case ignored, as the splice that used to make the key lower-cased
      // it); a text the prefix has not seen is a NEW row and takes the next free occurrence number (two rides, two coffees; the
      // second ride arriving in a later, overlapping file). Inside one (prefix, text) the rule is main's: `existing <= occurrence`.
      const textOf = (t: string | null | undefined) => (t == null ? null : t.trim().toLowerCase());
      // What main keyed on: the payee field of the file row (the text for a plain row, the chosen or associated payee's name for a client row).
      const incomingText = (txn: (typeof txns)[number]) => textOf(txn.import_payee_name ?? txn.payee)!;
      const existingByPrefix = new Map<string, { occ: number; text: string | null }[]>();
      // Whatever the rules say NOW, a stored row is recognised by what it was imported as: the same (amount, date) and the same
      // statement text (trimmed, compared exactly: another case or spacing is another text, as it was another key on main), under ANY key. A renaming rule added, changed or removed since changes the payee a text resolves to, so
      // the key it would count under; the rows already stored must not come in again (docs/decisions.md, "Rules apply going
      // forward"). Keys are `YNAB:<milli>:<date>:<payee id>:<occurrence>` and neither milli nor date has a colon.
      const baseOf = (txn: (typeof txns)[number]) => `YNAB:${txn.inflow - txn.outflow}:${txn.date}`;
      const textsByBase = new Map<string, Set<string>>();
      const bases = [...new Set(txns.filter((t) => !t.import_id).map(baseOf))];
      if (bases.length > 0) {
        for (const { import_id, text } of await txnStore.findImportRowsLike(client, account_id, bases.map((base) => `${base}:%`))) {
          const parts = import_id.split(':');
          if (parts.length !== 5 || text == null) continue;
          const base = parts.slice(0, 3).join(':');
          const set = textsByBase.get(base) ?? new Set<string>();
          set.add(text.trim());
          textsByBase.set(base, set);
        }
      }
      if (prefixes.length > 0) {
        const found = await txnStore.findImportRowsLike(
          client,
          account_id,
          prefixes.map((prefix) => `${prefix}:%`),
        );
        for (const { import_id, text } of found) {
          const cut = import_id.lastIndexOf(':');
          const occ = Number(import_id.slice(cut + 1));
          const prefix = import_id.slice(0, cut);
          if (prefixes.includes(prefix) && Number.isInteger(occ)) {
            const rows = existingByPrefix.get(prefix) ?? [];
            rows.push({ occ, text: textOf(text) });
            existingByPrefix.set(prefix, rows);
          }
        }
      }

      let imported = 0;
      let duplicates = 0;
      let unclearedDelta = 0; // milliunits, summed across inserted rows
      const batchOcc = new Map<string, number>(); // `${prefix}\0${text}` -> rows of this file so far (skipped ones too, as main counted)
      const lastOcc = new Map<string, number>(); // prefix -> highest occurrence number in use (stored and given in this file)
      for (const txn of txns) {
        const milliunits = txn.inflow - txn.outflow;
        let importId = txn.import_id ?? null;
        if (!importId) {
          const text = incomingText(txn);
          const k = await keysOf(txn);
          const own = prefixOf(txn, k.countKey);
          const prefixesOfRow = new Set([own, ...k.earlier.map((e) => prefixOf(txn, e))]);
          const counts = new Map<string, number>();
          for (const prefix of prefixesOfRow) {
            const bucket = `${prefix}\0${text}`;
            const n = (batchOcc.get(bucket) ?? 0) + 1;
            batchOcc.set(bucket, n);
            counts.set(prefix, n);
          }
          const known = (await lookupKeysOf(txn)).map((key) => prefixOf(txn, key));
          // Inside a (prefix, text) main's `existing <= occurrence` is true as soon as the text has a stored row: the stored rows are
          // numbered by their place among the rows of that text (a new text takes the next free number of the prefix, so its own
          // place is 1, as it was under its own key), and the first place is <= every occurrence. A stored row with no text on record
          // (very old) counts for any text, by its number, as before.
          const reimport = (textsByBase.get(baseOf(txn))?.has((txn.import_payee_name ?? txn.payee).trim()) ?? false) || known.some((prefix) => {
            const stored = existingByPrefix.get(prefix) ?? [];
            const n = counts.get(prefix) ?? Infinity;
            return stored.some((e) => e.text === text) || stored.some((e) => e.text === null && e.occ <= n);
          });
          if (reimport) {
            duplicates += 1;
            continue;
          }
          // A new row: its payee (and so its key) is created now when it does not exist. Its occurrence is the next free one of the prefix.
          const stored = existingByPrefix.get(own) ?? [];
          const occ = Math.max(lastOcc.get(own) ?? 0, ...stored.map((e) => e.occ)) + 1;
          lastOcc.set(own, occ);
          importId = `${prefixOf(txn, (await payeeByName.get(payeeKeyOfText(txn))?.key()) ?? '-')}:${occ}`;
        }
        const statementPayee = payeeByName.get(payeeKeyOfText(txn));
        // A payee that does not exist yet is created after the row is in: a duplicate row
        // (an explicit import id already present) creates nothing.
        const payeeId = (await statementPayee?.existingPayeeId()) ?? null;
        const inserted = await txnStore.insertBulkImportRow(client, {
          budgetId: budget_id,
          accountId: account_id,
          date: txn.date,
          amount: milliunits,
          payeeId,
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
        if (statementPayee && (await statementPayee.existingPayeeId()) === undefined) {
          await txnStore.setRowPayee(client, inserted, await statementPayee.createPayee());
        }
        const hint = statementPayee?.plan.transferAccountId;
        if (hint && hint !== account_id && !txn.category_id) await setTransferHint(client, budget_id, inserted, hint);
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

  implement(transactionsUpdate, async (_c, { id, budget_id, patch, subtransactions }) =>
    withTransaction(pool, (client) =>
      updateTransactionInClient(client, { budgetId: budget_id, id, patch, subtransactions }),
    ),
  ),

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
      // Deleting one side of a transfer takes the other out of the pair: a
      // hand-made mirror is deleted (its reversal is server-derived like every
      // mirror delta); a bank row the matcher linked is restored, never deleted.
      const mirrorDeltas = deleted.transfer_transaction_id
        ? await removeMirror(client, budgetId, id, deleted.transfer_transaction_id)
        : [];
      await applyBalanceDeltas(client, budgetId, [
        ...(deleted.upcoming ? [] : deriveDeltas(deleted, null)),
        ...mirrorDeltas,
      ]);
    });
  }),
];

export default budgetRouter('/transactions', operations);
