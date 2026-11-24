/**
 * The candidate set must equal the app's own definition of "needs a category"
 * (client/src/domain/register.ts) plus the facts the register screen scopes
 * by: inflows, adjustments, transfers, tracking/closed accounts. The first
 * block imports the CLIENT function and fails if the SQL ever diverges for a
 * case that function can express; the rest exercises the exclusions the screen
 * gets from its account scope and the server's transfer state.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { registerCategoryCell } from '../../../client/src/domain/register';
import type { Budget as ClientBudget } from '../../../client/src/domain/types';
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

describe.skipIf(!dbReady)('candidate set matches the client rule', () => {
  test('registerCategoryCell agrees with the SQL for rows the cell can express', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const account = {
      id: a.accountId,
      name: 'Checking',
      type: 'checking' as const,
      group: 'CASH' as const,
      onBudget: true,
      clearedBalance: 0,
      unclearedBalance: 0,
      lastReconciledAt: null,
      userId: null,
    };
    const peer = { ...account, id: savings, name: 'Savings' };
    const budget: Pick<ClientBudget, 'accounts' | 'categories'> = { accounts: [account, peer], categories: [] };
    const warn = (row: { payee: string; inflow: number; splits?: boolean }) =>
      registerCategoryCell(budget, {
        payee: row.payee,
        categoryId: null,
        splits: row.splits ? [{ id: 's1', categoryId: null, memo: '', outflow: row.inflow, inflow: 0 }] : undefined,
        inflow: row.inflow,
      }).warn;

    const cases: { row: { payee: string; inflow: number; splits?: boolean }; id: string }[] = [
      { row: { payee: 'Padaria', inflow: 0 }, id: await outflow({ importPayeeName: 'Padaria' }) },
      { row: { payee: 'Salary', inflow: 500_000 }, id: await outflow({ amount: 500_000, importPayeeName: 'Salary' }) },
      { row: { payee: 'Zero', inflow: 0 }, id: await outflow({ amount: 0, importPayeeName: 'Zero' }) },
      { row: { payee: 'Reconciliation Adjustment', inflow: 0 }, id: await outflow({ importPayeeName: 'Reconciliation Adjustment' }) },
      { row: { payee: 'Balance Adjustment', inflow: 0 }, id: await outflow({ importPayeeName: 'Balance Adjustment' }) },
      { row: { payee: 'Split parent', inflow: 0, splits: true }, id: await outflow({ importPayeeName: 'Split parent' }) },
      { row: { payee: 'Transfer : Savings', inflow: 0 }, id: await outflow({ importPayeeName: 'Transfer : Savings' }) },
    ];
    // A split parent is a row WITH live legs; the cell only sees the flag.
    await pool.query(
      `insert into public.subtransactions (id, transaction_id, budget_id, category_id, amount) values (gen_random_uuid(), $1, $2, $3, -2500)`,
      [cases[5]!.id, a.budgetId, a.food],
    );

    const ids = await candidateIds();
    for (const c of cases) expect({ id: c.id, candidate: ids.has(c.id) }).toEqual({ id: c.id, candidate: warn(c.row) });
  });
});

describe.skipIf(!dbReady)('candidate exclusions', () => {
  test('inflows, adjustments, splits, upcoming, transfers and split legs are never sent to the model', async () => {
    const savings = await newAccount(a.budgetId, 'Savings');
    const card = await newAccount(a.budgetId, 'Card', { type: 'creditCard', group: 'CREDIT' });
    const gone = await newAccount(a.budgetId, 'Gone');
    const noCategory = await outflow({ importPayeeName: 'COUNTED STORE' });
    const unique = {
      inflow: await outflow({ amount: 400_000, importPayeeName: 'SALARY' }),
      reconciliation: await outflow({ importPayeeName: 'Reconciliation Adjustment' }),
      balance: await outflow({ importPayeeName: 'Balance Adjustment' }),
      upcoming: await outflow({ importPayeeName: 'SCHEDULED', upcoming: true }),
      linkedAccount: await outflow({ importPayeeName: 'TRANSFER OUT', transferAccountId: savings }),
      linkedTransaction: await outflow({ importPayeeName: 'TRANSFER OUT 2', transferTransactionId: crypto.randomUUID() }),
      markedOutside: await outflow({ importPayeeName: 'SUSPECT', mark: 'outside' }),
      transferPayee: await outflow({ importPayeeName: 'Transfer : Savings' }),
      cardPayment: await outflow({ importPayeeName: 'Transfer : Card' }),
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
    // A dismissed mark means "not a transfer": the row is normal spending.
    const dismissed = await outflow({ importPayeeName: 'NOT A TRANSFER', mark: 'dismissed' });

    const ids = await candidateIds();
    expect(ids.has(noCategory)).toBe(true);
    expect(ids.has(dismissed)).toBe(true);
    for (const [name, id] of Object.entries(unique)) expect({ name, candidate: ids.has(id) }).toEqual({ name, candidate: false });
  });

  test('a payee transfer rule hides a waiting/outside row but not one it gave up for review', async () => {
    const recent = await newPayee(a.budgetId, 'Waiting Payee', { transferRule: 'auto', transferRuleWaitDays: 5 });
    const old = await newPayee(a.budgetId, 'Review Payee', { transferRule: 'auto', transferRuleWaitDays: 5, transferRuleNoMatch: 'review' });
    const outside = await newPayee(a.budgetId, 'Outside Payee', {
      transferRule: 'account',
      transferRuleWaitDays: 5,
      transferRuleNoMatch: 'outside',
    });
    const waiting = await outflow({ payeeId: recent, importPayeeName: 'WAITING' });
    const givenUp = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      date: '2020-01-01',
      amount: -700,
      payeeId: old,
      importPayeeName: 'OLD REVIEW',
    });
    const outsideRow = await newTransaction({
      budgetId: a.budgetId,
      accountId: a.accountId,
      date: '2020-01-02',
      amount: -800,
      payeeId: outside,
      importPayeeName: 'OLD OUTSIDE',
    });

    const ids = await candidateIds();
    expect(ids.has(waiting)).toBe(false);
    expect(ids.has(outsideRow)).toBe(false);
    // After wait_days with no_match=review the app shows the row as spending
    // to categorize, so the run may suggest one.
    expect(ids.has(givenUp)).toBe(true);
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
