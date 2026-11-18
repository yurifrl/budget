/**
 * GET /budgets/export?budget_id=<uuid> — full budget export (backup).
 *
 * Emits the exact payload POST /budgets/restore accepts (groups, categories,
 * accounts, transactions, assignments — money in CENTS, cross-references as
 * array indexes), so export -> restore round-trips. Sections restore does not
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
import { budgetRouter } from '../router';

interface Row {
  [column: string]: unknown;
}

const cents = (milli: unknown): number => Number(milli) / 10;

export const operations = [
  implement(budgetExport, async (_c, { budget_id: budgetId }) => {
    const q = async (sql: string): Promise<Row[]> => (await pool.query<Row>(sql, [budgetId])).rows;

    const budget = (await q('SELECT name, archived_at FROM budgets WHERE id = $1'))[0];
    if (!budget) throw new HttpError(404, 'budget not found');

    const groups = await q(
      'SELECT id, name FROM category_groups WHERE budget_id = $1 AND NOT deleted ORDER BY sort_order, name, id',
    );
    const groupIndex = new Map(groups.map((g, i) => [g.id, i]));

    const categories = (
      await q(
        `SELECT c.id, c.group_id, c.name, c.hidden, c.user_id, c.bundle_id FROM categories c
         JOIN category_groups g ON g.id = c.group_id AND NOT g.deleted
         WHERE c.budget_id = $1 AND NOT c.deleted
         ORDER BY g.sort_order, g.name, g.id, c.sort_order, c.name, c.id`,
      )
    ).filter((c) => groupIndex.has(c.group_id));
    const bundleRows = (
      await q(
        `SELECT b.id, b.group_id, b.name FROM category_bundles b
         WHERE b.budget_id = $1 ORDER BY b.created_at, b.name, b.id`,
      )
    ).filter((b) => groupIndex.has(b.group_id));
    const bundles = bundleRows
      .map((b) => ({ id: b.id, groupIndex: groupIndex.get(b.group_id) as number, name: b.name as string }))
      .sort((a, b) => a.groupIndex - b.groupIndex || a.name.localeCompare(b.name));
    const bundleIndex = new Map(bundles.map((b, i) => [b.id, i]));
    const categoryIndex = new Map(categories.map((c, i) => [c.id, i]));

    const accounts = await q(
      'SELECT id, name, user_id FROM accounts WHERE budget_id = $1 AND NOT deleted ORDER BY sort_order, name, id',
    );
    const accountIndex = new Map(accounts.map((a, i) => [a.id, i]));

    // Upcoming (repeat-rule) occurrences are not ledger history: restore would
    // post them as real transactions, so they travel via repeat_rules instead.
    const txnRows = await q(
      `SELECT t.id, t.account_id, t.date::text AS date, t.amount, t.memo, t.cleared::text AS cleared,
              t.category_id, t.transfer_transaction_id, t.flag_color, t.flag_name, p.name AS payee
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.budget_id = $1 AND NOT t.deleted AND NOT t.upcoming
       ORDER BY t.date, t.amount, t.memo, t.id`,
    );
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

    const splitRows = await q(
      `SELECT s.transaction_id, s.amount, s.memo, s.category_id FROM subtransactions s
       WHERE s.budget_id = $1 AND NOT s.deleted ORDER BY s.created_at, s.amount, s.memo, s.id`,
    );
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
        outflow: Math.max(-amount, 0) / 10,
        inflow: Math.max(amount, 0) / 10,
        cleared: t.cleared,
        flag: ((t.flag_color ?? t.flag_name) as string | null) ?? '',
        transferPeerIndex: peer ?? null,
      };
    });

    const assignments = (
      await q(
        `SELECT category_id, month::text AS month, budgeted FROM assignments
         WHERE budget_id = $1 ORDER BY month, category_id`,
      )
    )
      .filter((a) => categoryIndex.has(a.category_id))
      .map((a) => ({
        categoryIndex: categoryIndex.get(a.category_id) as number,
        month: a.month,
        budgeted: cents(a.budgeted),
      }))
      .sort((a, b) => String(a.month).localeCompare(String(b.month)) || a.categoryIndex - b.categoryIndex);

    const payees = await q(
      'SELECT name FROM payees WHERE budget_id = $1 AND NOT deleted AND transfer_account_id IS NULL ORDER BY name',
    );
    const targets = await q(
      'SELECT category_id, kind, amount_cents, config FROM category_targets WHERE budget_id = $1',
    );
    const categoryNotes = await q(
      "SELECT category_id, month::text AS month, note FROM category_notes WHERE budget_id = $1 ORDER BY month",
    );
    const monthNotes = await q(
      'SELECT month::text AS month, note FROM month_notes WHERE budget_id = $1 AND NOT deleted ORDER BY month',
    );
    const rules = await q(
      `SELECT r.account_id, r.category_id, r.memo, r.amount, r.frequency, r.next_due_date::text AS next_due_date,
              r.month_last_day, p.name AS payee
       FROM txn_repeat_rules r LEFT JOIN payees p ON p.id = r.payee_id
       WHERE r.budget_id = $1 AND NOT r.deleted ORDER BY r.created_at, r.id`,
    );

    return {
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
      accounts: accounts.map((a) => ({ name: a.name, userId: (a.user_id as string | null) ?? null })),
      transactions,
      assignments,
      payees: payees.map((p) => p.name),
      category_targets: targets
        .filter((t) => categoryIndex.has(t.category_id))
        .map((t) => ({
          categoryIndex: categoryIndex.get(t.category_id) as number,
          kind: t.kind,
          amount_cents: Number(t.amount_cents),
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
          amount_cents: cents(r.amount),
          frequency: r.frequency,
          next_due_date: r.next_due_date,
          month_last_day: Boolean(r.month_last_day),
        })),
      splits: liveTxns.flatMap((t) =>
        (splitsByTxn.get(t.id) ?? []).map((s) => ({
          transactionIndex: txnIndex.get(t.id) as number,
          amount_cents: cents(s.amount),
          memo: (s.memo as string | null) ?? '',
          categoryIndex: categoryIndex.get(s.category_id) ?? null,
        })),
      ),
    };
  }),
];

export default budgetRouter('/budgets/export', operations);
