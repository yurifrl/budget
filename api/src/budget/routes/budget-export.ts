/**
 * GET /budgets/export?budget_id=<uuid> — full budget export (backup).
 *
 * Emits the exact payload POST /budgets/restore accepts (groups, categories,
 * accounts, transactions, assignments — format_version 2: money in
 * MILLIUNITS, as stored; cross-references as array indexes), so export ->
 * restore round-trips. Sections restore does not
 * carry are added alongside and ignored by it: budget, payees,
 * category_targets, category_notes, month_notes, repeat_rules and splits
 * (cross-references by index as well; split parents export with their summed
 * amount and no category, like the restore format expects).
 *
 * Scoping is the router's budgetAccess (owner-or-admin, else 404).
 */

import { pool } from '../../core/db';
import { implement } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { budgetExport } from '@shared/contracts/budget';
import { BACKUP_FORMAT_VERSION } from '@shared/contracts/budget/schemas';
import { budgetRouter } from '../router';
import {
  exportAccounts,
  exportAssignments,
  exportBudgetRow,
  exportBundles,
  exportCategories,
  exportCategoryNotes,
  exportGroups,
  exportMonthNotes,
  exportPayees,
  exportRepeatRules,
  exportSplits,
  exportTargets,
  exportTransactions,
  type Row,
} from '../store/export';

const milli = (value: unknown): number => Number(value);

export const operations = [
  implement(budgetExport, async (_c, { budget_id: budgetId }) => {
    const budget = await exportBudgetRow(pool, budgetId);
    if (!budget) throw new HttpError(404, 'budget not found');

    const groups = await exportGroups(pool, budgetId);
    const groupIndex = new Map(groups.map((g, i) => [g.id, i]));

    const categories = (await exportCategories(pool, budgetId)).filter((c) => groupIndex.has(c.group_id));
    const bundleRows = (await exportBundles(pool, budgetId)).filter((b) => groupIndex.has(b.group_id));
    const bundles = bundleRows
      .map((b) => ({ id: b.id, groupIndex: groupIndex.get(b.group_id) as number, name: b.name as string }))
      .sort((a, b) => a.groupIndex - b.groupIndex || a.name.localeCompare(b.name));
    const bundleIndex = new Map(bundles.map((b, i) => [b.id, i]));
    const categoryIndex = new Map(categories.map((c, i) => [c.id, i]));

    const accounts = await exportAccounts(pool, budgetId);
    const accountIndex = new Map(accounts.map((a, i) => [a.id, i]));

    // Upcoming (repeat-rule) occurrences are not ledger history: restore would
    // post them as real transactions, so they travel via repeat_rules instead.
    const txnRows = await exportTransactions(pool, budgetId);
    const liveTxns = txnRows.filter((t) => accountIndex.has(t.account_id));
    // Deterministic order independent of ids: date, account, amount, memo.
    liveTxns.sort(
      (a, b) =>
        String(a.date).localeCompare(String(b.date)) ||
        (accountIndex.get(a.account_id) as number) - (accountIndex.get(b.account_id) as number) ||
        Number(a.amount) - Number(b.amount) ||
        String(a.memo ?? '').localeCompare(String(b.memo ?? '')),
    );
    const txnIndex = new Map(liveTxns.map((t, i) => [t.id, i]));

    const splitRows = await exportSplits(pool, budgetId);
    const splitsByTxn = new Map<unknown, Row[]>();
    for (const s of splitRows) splitsByTxn.set(s.transaction_id, [...(splitsByTxn.get(s.transaction_id) ?? []), s]);

    const transactions = liveTxns.map((t) => {
      const splits = splitsByTxn.get(t.id);
      const amount = splits ? splits.reduce((sum, s) => sum + Number(s.amount), 0) : Number(t.amount);
      const peer = t.transfer_transaction_id == null ? undefined : txnIndex.get(t.transfer_transaction_id);
      return {
        accountIndex: accountIndex.get(t.account_id) as number,
        date: t.date,
        // Transfer legs restore their "Transfer : <account>" payee from the peer link.
        payee: peer === undefined ? ((t.payee as string | null) ?? '') : '',
        categoryIndex: splits ? null : (categoryIndex.get(t.category_id) ?? null),
        memo: (t.memo as string | null) ?? '',
        outflow: Math.max(-amount, 0),
        inflow: Math.max(amount, 0),
        cleared: t.cleared,
        flag: ((t.flag_color ?? t.flag_name) as string | null) ?? '',
        transferPeerIndex: peer ?? null,
      };
    });

    const assignments = (await exportAssignments(pool, budgetId))
      .filter((a) => categoryIndex.has(a.category_id))
      .map((a) => ({
        categoryIndex: categoryIndex.get(a.category_id) as number,
        month: a.month,
        budgeted: milli(a.budgeted),
      }))
      .sort((a, b) => String(a.month).localeCompare(String(b.month)) || a.categoryIndex - b.categoryIndex);

    const payees = await exportPayees(pool, budgetId);
    const targets = await exportTargets(pool, budgetId);
    const categoryNotes = await exportCategoryNotes(pool, budgetId);
    const monthNotes = await exportMonthNotes(pool, budgetId);
    const rules = await exportRepeatRules(pool, budgetId);

    return {
      format_version: BACKUP_FORMAT_VERSION,
      budget: { name: budget.name, archived: budget.archived_at != null },
      groups: groups.map((g) => g.name),
      categories: categories.map((c) => ({
        groupIndex: groupIndex.get(c.group_id) as number,
        name: c.name,
        hidden: Boolean(c.hidden),
        userId: (c.user_id as string | null) ?? null,
        bundleIndex: bundleIndex.get(c.bundle_id) ?? null,
      })),
      bundles: bundles.map((b) => ({ groupIndex: b.groupIndex, name: b.name })),
      accounts: accounts.map((a) => ({
        name: a.name,
        userId: (a.user_id as string | null) ?? null,
        currency: (a.currency as string | null) ?? null,
      })),
      transactions,
      assignments,
      payees: payees.map((p) => p.name),
      category_targets: targets
        .filter((t) => categoryIndex.has(t.category_id))
        .map((t) => ({
          categoryIndex: categoryIndex.get(t.category_id) as number,
          kind: t.kind,
          // category_targets stores cents; the document carries milliunits.
          amount: Number(t.amount_cents) * 10,
          config: t.config,
        })),
      category_notes: categoryNotes
        .filter((n) => categoryIndex.has(n.category_id))
        .map((n) => ({ categoryIndex: categoryIndex.get(n.category_id) as number, month: n.month, note: n.note })),
      month_notes: monthNotes.map((n) => ({ month: n.month, note: n.note })),
      repeat_rules: rules
        .filter((r) => accountIndex.has(r.account_id))
        .map((r) => ({
          accountIndex: accountIndex.get(r.account_id) as number,
          categoryIndex: categoryIndex.get(r.category_id) ?? null,
          payee: (r.payee as string | null) ?? '',
          memo: (r.memo as string | null) ?? '',
          amount: milli(r.amount),
          frequency: r.frequency,
          next_due_date: r.next_due_date,
          month_last_day: Boolean(r.month_last_day),
        })),
      splits: liveTxns.flatMap((t) =>
        (splitsByTxn.get(t.id) ?? []).map((s) => ({
          transactionIndex: txnIndex.get(t.id) as number,
          amount: milli(s.amount),
          memo: (s.memo as string | null) ?? '',
          categoryIndex: categoryIndex.get(s.category_id) ?? null,
        })),
      ),
    };
  }),
];

export default budgetRouter('/budgets/export', operations);
