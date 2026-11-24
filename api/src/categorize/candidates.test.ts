/**
 * The candidate SQL must equal the app's own "needs a category" rule
 * (shared/src/domain/category-needs.ts, the function the register cell uses)
 * over the same rows, plus the register screen's scope and the run's own
 * bookkeeping. This test builds one fixture set, feeds each row's facts to the
 * shared predicate, and compares that verdict with the SQL candidate set — no
 * client import.
 *
 * The transfer-pending half comes from the app's transfer plan
 * (`transferOverview`, the register's `transferPending` source), not from a
 * second copy in SQL; the cases below cover the divergences that a second copy
 * had (manual marks, dismissed marks under a payee rule, rule rows with an open
 * counterpart).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { needsCategory } from '@shared/domain/category-needs';
import { isInternalTransferPayee } from '@shared/domain/transfers';

import { transferOverview } from '../budget';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import * as store from './store';
import { cleanupFixtures, newAccount, newBudget, newPayee, newTransaction, type BudgetFixture } from './testing';

const MAX = { date: '9999-12-31', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
let a: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  a = await newBudget('candidates');
});

afterAll(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
});

async function candidateIds(): Promise<Set<string>> {
  const rows = await store.listCandidates(pool, a.budgetId, { snapshot: MAX, cursor: null, limit: 200, force: true });
  return new Set(rows.map((row) => row.id));
}

const outflow = (extra: Partial<Parameters<typeof newTransaction>[0]> = {}) =>
  newTransaction({ budgetId: a.budgetId, accountId: a.accountId, date: '2026-11-01', amount: -2500, ...extra });

describe.skipIf(!dbReady)('candidate set equals the shared needs-category rule', () => {
  test('every app-rule case agrees with the SQL over the same rows', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const accounts = (
      await pool.query<{ name: string; on_budget: boolean }>('select name, on_budget from public.accounts where budget_id = $1 and deleted = false', [
        a.budgetId,
      ])
    ).rows.map((row) => ({ name: row.name, onBudget: row.on_budget }));

    const waitingPayee = await newPayee(a.budgetId, 'Waiting Payee', { transferRule: 'auto', transferRuleWaitDays: 5 });
    const outsidePayee = await newPayee(a.budgetId, 'Outside Payee', {
      transferRule: 'account',
      transferRuleWaitDays: 5,
      transferRuleNoMatch: 'outside',
    });
    const reviewPayee = await newPayee(a.budgetId, 'Review Payee', { transferRule: 'auto', transferRuleWaitDays: 5, transferRuleNoMatch: 'review' });
    const dismissedRulePayee = await newPayee(a.budgetId, 'Dismissed Rule Payee', { transferRule: 'auto', transferRuleWaitDays: 5 });
    const openPayee = await newPayee(a.budgetId, 'Open Payee', { transferRule: 'auto', transferRuleWaitDays: 5 });

    const plain = await outflow({ importPayeeName: 'Padaria' });
    const zero = await outflow({ amount: 0, importPayeeName: 'Zero' });
    const inflow = await outflow({ amount: 500_000, importPayeeName: 'Salary' });
    const adjustment = await outflow({ importPayeeName: 'Reconciliation Adjustment' });
    const balance = await outflow({ importPayeeName: 'Balance Adjustment' });
    const split = await outflow({ importPayeeName: 'Split parent' });
    const transferPayee = await outflow({ importPayeeName: 'Transfer : Savings' });
    const waiting = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      // Inside the rule's 5-day wait window (today is the test day).
      date: '2099-01-01',
      amount: -2500,
      payeeId: waitingPayee,
      importPayeeName: 'WAITING',
    });
    const outside = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      date: '2020-01-02',
      amount: -800,
      payeeId: outsidePayee,
      importPayeeName: 'OLD OUTSIDE',
    });
    const review = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      date: '2020-01-01',
      amount: -700,
      payeeId: reviewPayee,
      importPayeeName: 'OLD REVIEW',
    });
    const manual = await outflow({ importPayeeName: 'UNLINKED BY PERSON', mark: 'manual' });
    const dismissedUnderRule = await outflow({ payeeId: dismissedRulePayee, importPayeeName: 'DISMISSED MARK', mark: 'dismissed' });
    // A rule row with an open counterpart: the planner pairs it (not pending),
    // so the app still shows it as needing a category.
    const open = await outflow({ payeeId: openPayee, importPayeeName: 'OPEN RULE' });
    const counterpart = await newTransaction({
      budgetId: a.budgetId,
      accountId: savings,
      date: '2026-11-01',
      amount: 2500,
      importPayeeName: 'OPEN RULE IN',
    });

    await pool.query(
      `insert into public.subtransactions (id, transaction_id, budget_id, category_id, amount) values (gen_random_uuid(), $1, $2, $3, -2500)`,
      [split, a.budgetId, a.food],
    );

    const splitCounts = new Map<string, number>();
    for (const row of (
      await pool.query<{ transaction_id: string; n: number }>(
        'select transaction_id, count(*)::int as n from public.subtransactions where budget_id = $1 and deleted = false group by transaction_id',
        [a.budgetId],
      )
    ).rows) {
      splitCounts.set(row.transaction_id, row.n);
    }
    const pending = (await transferOverview(pool, a.budgetId)).pending;

    const cases: { id: string; payee: string; amount: number }[] = [
      { id: plain, payee: 'Padaria', amount: -2500 },
      { id: zero, payee: 'Zero', amount: 0 },
      { id: inflow, payee: 'Salary', amount: 500_000 },
      { id: adjustment, payee: 'Reconciliation Adjustment', amount: -2500 },
      { id: balance, payee: 'Balance Adjustment', amount: -2500 },
      { id: split, payee: 'Split parent', amount: -2500 },
      { id: transferPayee, payee: 'Transfer : Savings', amount: -2500 },
      { id: waiting, payee: 'WAITING', amount: -2500 },
      { id: outside, payee: 'OLD OUTSIDE', amount: -800 },
      { id: review, payee: 'OLD REVIEW', amount: -700 },
      { id: manual, payee: 'UNLINKED BY PERSON', amount: -2500 },
      { id: dismissedUnderRule, payee: 'DISMISSED MARK', amount: -2500 },
      { id: open, payee: 'OPEN RULE', amount: -2500 },
      { id: counterpart, payee: 'OPEN RULE IN', amount: 2500 },
    ];

    const ids = await candidateIds();
    for (const c of cases) {
      const expected = needsCategory({
        payee: c.payee,
        categoryId: null,
        splitCount: splitCounts.get(c.id) ?? 0,
        amount: c.amount,
        transferPending: pending.get(c.id) ?? null,
        transferPayee: isInternalTransferPayee(c.payee, accounts),
      });
      expect({ id: c.id, candidate: ids.has(c.id) }).toEqual({ id: c.id, candidate: expected });
    }
    // The divergence cases are explicit: a manual mark and a dismissed mark
    // under an active payee rule are not pending, and both need a category.
    expect(pending.has(manual)).toBe(false);
    expect(pending.has(dismissedUnderRule)).toBe(false);
    expect(ids.has(manual)).toBe(true);
    expect(ids.has(dismissedUnderRule)).toBe(true);
    // Waiting/outside plan rows are pending and are not candidates.
    expect(pending.get(waiting)).toBe('waiting');
    expect(pending.get(outside)).toBe('outside');
    expect(ids.has(waiting)).toBe(false);
    expect(ids.has(outside)).toBe(false);
    // A rule row with an open counterpart is paired by the plan, not pending.
    expect(pending.has(open)).toBe(false);
    expect(ids.has(open)).toBe(true);
  });
});

describe.skipIf(!dbReady)('candidate exclusions outside the register rule', () => {
  test('upcoming, linked, off-budget, closed, deleted and split-leg rows are never sent to the model', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const gone = await newAccount(a.budgetId, 'Gone');
    const noCategory = await outflow({ importPayeeName: 'COUNTED STORE' });
    const unique = {
      upcoming: await outflow({ importPayeeName: 'SCHEDULED', upcoming: true }),
      linkedAccount: await outflow({ importPayeeName: 'TRANSFER OUT', transferAccountId: savings }),
      linkedTransaction: await outflow({ importPayeeName: 'TRANSFER OUT 2', transferTransactionId: crypto.randomUUID() }),
      splitParent: await outflow({ importPayeeName: 'SPLIT' }),
      offBudget: await outflow({
        accountId: await newAccount(a.budgetId, 'Brokerage', { onBudget: false }),
        importPayeeName: 'BROKER',
      }),
      closed: await outflow({ accountId: await newAccount(a.budgetId, 'Old', { closed: true }), importPayeeName: 'OLD' }),
      deletedAccount: await outflow({ accountId: gone, importPayeeName: 'GONE' }),
    };
    await pool.query('update public.accounts set deleted = true where id = $1', [gone]);
    await pool.query(
      `insert into public.subtransactions (id, transaction_id, budget_id, category_id, amount) values (gen_random_uuid(), $1, $2, $3, -500)`,
      [unique.splitParent, a.budgetId, a.food],
    );

    const ids = await candidateIds();
    expect(ids.has(noCategory)).toBe(true);
    for (const [name, id] of Object.entries(unique)) expect({ name, candidate: ids.has(id) }).toEqual({ name, candidate: false });
  });

  test('force is the only way back in once a transaction has a suggestion', async () => {
    const txn = await outflow({ importPayeeName: 'ONCE' });
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source)
       values ($1, $2, 1, $3, 0.5, 'ai')`,
      [txn, a.budgetId, a.food],
    );
    const normal = await store.listCandidates(pool, a.budgetId, { snapshot: MAX, cursor: null, limit: 50, force: false });
    expect(normal.map((row) => row.id)).not.toContain(txn);
    const forced = await store.listCandidates(pool, a.budgetId, { snapshot: MAX, cursor: null, limit: 50, force: true });
    expect(forced.map((row) => row.id)).toContain(txn);
  });
});
