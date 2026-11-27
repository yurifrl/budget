/**
 * The candidate rule, proved in two places at once: the run's SQL asks about
 * exactly the rows the shared register rule (`needsCategory`) calls
 * "needs a category". The rows here are the cases that used to slip through —
 * a deleted row, more than one inflow, a zero amount, a categorized row, an
 * upcoming row, a split parent, an internal transfer payee, a row linked to
 * another account, a payee that points at another account, a credit-card
 * payment row, an auto-booked adjustment, a row the transfer plan marked
 * pending — plus the account filters the register applies before it ever asks
 * the rule.
 *
 * The oracle's inputs are read back from the rows in the database, so the test
 * cannot drift from what a run actually sees.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { needsCategory, type CategoryNeedInput } from '@shared/domain/category-needs';
import { isInternalTransferPayee, isTransferToOnBudget } from '@shared/domain/transfers';

import { transferOverview } from '../budget';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { pendingTransferIds } from './store';
import { openAccounts, runCandidates } from './run-store';
import { cleanupFixtures, newAccount, newBudget, newCategory, newGroup, newPayee, newTransaction, type BudgetFixture } from './testing';

const MAX_ATTEMPTS = 3;

/** A page big enough that these fixtures fit in one, so the test reads every row. */
const ALL_ROWS = 500;

/** One transaction as the oracle rule reads it. */
type Row = {
  id: string;
  account_id: string;
  payee: string;
  category_id: string | null;
  amount: number;
  split_count: number;
  /** The row's own transfer pointer, or the one its payee carries. */
  peer_account_id: string | null;
};

/** A budget account as the register's rules see it. */
type Account = { id: string; name: string; on_budget: boolean; closed: boolean };

/**
 * The rule's inputs for every row of every account the register renders, read
 * from the database: the test asks the same question a screen asks.
 */
async function oracleInputs(
  budgetId: string,
  pending: ReadonlyMap<string, 'waiting' | 'outside'>,
): Promise<{ id: string; input: CategoryNeedInput }[]> {
  const { rows: accounts } = await pool.query<Account>(
    'select id, name, on_budget, closed from public.accounts where budget_id = $1 and deleted = false',
    [budgetId],
  );
  const rendered = accounts.filter((account) => account.on_budget && !account.closed);
  const transfers = accounts
    .filter((account) => account.on_budget)
    .map((account) => ({ id: account.id, name: account.name, onBudget: account.on_budget }));
  const { rows } = await pool.query<Row>(
    `select t.id, t.account_id, coalesce(p.name, t.import_payee_name, '') as payee, t.category_id, t.amount,
            coalesce(t.transfer_account_id, p.transfer_account_id) as peer_account_id,
            (select count(*)::int from public.subtransactions s
              where s.transaction_id = t.id and s.deleted = false) as split_count
       from public.transactions t
       left join public.payees p on p.id = t.payee_id and p.budget_id = t.budget_id
      where t.budget_id = $1
        and t.deleted = false
        and t.upcoming = false
        and t.account_id = any($2::uuid[])`,
    [budgetId, rendered.map((account) => account.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    input: {
      payee: row.payee,
      categoryId: row.category_id,
      splitCount: row.split_count,
      amount: row.amount,
      transferPending: pending.get(row.id) ?? null,
      transferPayee:
        isInternalTransferPayee(row.payee, transfers) ||
        isTransferToOnBudget(transfers, row.account_id, row.peer_account_id),
    },
  }));
}

describe.skipIf(!dbReady)('the run candidate rule', () => {
  let b: BudgetFixture;
  /** Rows of accounts the register never renders, so the rule is never asked. */
  let hiddenAccounts: string[];
  /** A row the transfer plan marked as a transfer out of the budget. */
  let pendingRow: string;

  beforeEach(async () => {
    b = await newBudget('candidates');
    hiddenAccounts = [];

    const payee = await newPayee(b.budgetId, 'Mercado');
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: -3000, payeeId: payee });

    // Two inflows: money in never needs a category, and neither does a second one.
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: 5000 });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: 1000 });

    // A zero amount is still a question (the register shows it as needing one).
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: 0 });

    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-01', amount: -1200, categoryId: b.food });

    const deleted = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-02', amount: -1100 });
    await pool.query('update public.transactions set deleted = true where id = $1', [deleted]);

    const upcoming = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-03',
      amount: -1100,
      upcoming: true,
    });

    const split = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-04', amount: -1500 });
    await pool.query(
      `insert into public.subtransactions (budget_id, transaction_id, amount, category_id, deleted)
       values ($1, $2, -1000, $3, false), ($1, $2, -500, $3, true)`,
      [b.budgetId, split, b.food],
    );

    // A credit-card payment row is filed into the credit-card payments group,
    // so it is categorized and the run must leave it alone.
    const cardGroup = await newGroup(b.budgetId, 'Card payments');
    await pool.query('update public.category_groups set is_credit_card_payments = true where id = $1', [cardGroup]);
    const cardPayment = await newCategory(b.budgetId, cardGroup, 'Visa payment');
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-04',
      amount: -8000,
      categoryId: cardPayment,
    });

    // An internal "Transfer : <account>" payee.
    const transferPayee = await newPayee(b.budgetId, 'Transfer : Savings');
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -4000, payeeId: transferPayee });

    // A linked pair between two on-budget accounts: no category either side.
    const savings = await newAccount(b.budgetId, 'Savings');
    const leg = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-05',
      amount: -2500,
      transferAccountId: savings,
    });
    await newTransaction({
      budgetId: b.budgetId,
      accountId: savings,
      date: '2026-11-05',
      amount: 2500,
      transferAccountId: b.accountId,
      transferTransactionId: leg,
    });
    await pool.query('update public.transactions set transfer_transaction_id = $2 where id = $1', [
      leg,
      (
        await pool.query<{ id: string }>(
          'select id from public.transactions where transfer_transaction_id = $1 and id <> $1',
          [leg],
        )
      ).rows[0]!.id,
    ]);

    // The same pointer at an account that is off budget: the money leaves, so
    // the row keeps a category.
    const tracking = await newAccount(b.budgetId, 'Brokerage', { onBudget: false });
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-05',
      amount: -3100,
      transferAccountId: tracking,
    });

    // A payee that points at another account, on budget (no category) and off
    // budget (still a question).
    const toSavings = await newPayee(b.budgetId, 'Move to savings', { transferAccountId: savings });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -1200, payeeId: toSavings });
    const toBroker = await newPayee(b.budgetId, 'Move to broker', { transferAccountId: tracking });
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-05', amount: -1300, payeeId: toBroker });

    // Another budget's on-budget account is not this budget's: the money leaves
    // this budget, so the row stays a question.
    const elsewhere = await newBudget('candidates-elsewhere');
    const foreign = await newAccount(elsewhere.budgetId, 'Savings');
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-05',
      amount: -3200,
      transferAccountId: foreign,
    });

    // A pointer at the row's OWN account is not a transfer either.
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-05',
      amount: -3300,
      transferAccountId: b.accountId,
    });

    // The same transfer payee text with a trailing space: read trimmed it still
    // names Savings, so the row is a transfer and not a question.
    const spacedPayee = await newPayee(b.budgetId, 'Transfer : Savings ');
    await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-05',
      amount: -4100,
      payeeId: spacedPayee,
    });

    const reconcilePayee = await newPayee(b.budgetId, 'Reconciliation Adjustment');
    await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-06', amount: -700, payeeId: reconcilePayee });

    // A row the transfer plan keeps outside the budget.
    pendingRow = await newTransaction({
      budgetId: b.budgetId,
      accountId: b.accountId,
      date: '2026-11-07',
      amount: -2200,
      mark: 'outside',
    });

    // Accounts the register never renders: their rows are not questions.
    const closed = await newAccount(b.budgetId, 'Old', { closed: true });
    hiddenAccounts.push(await newTransaction({ budgetId: b.budgetId, accountId: closed, date: '2026-11-09', amount: -900 }));
    const gone = await newAccount(b.budgetId, 'Gone');
    await pool.query('update public.accounts set deleted = true where id = $1', [gone]);
    hiddenAccounts.push(await newTransaction({ budgetId: b.budgetId, accountId: gone, date: '2026-11-10', amount: -900 }));
    hiddenAccounts.push(
      await newTransaction({ budgetId: b.budgetId, accountId: tracking, date: '2026-11-08', amount: -900 }),
    );

    // Guard: the fixtures above must actually reach both sides (a row that was
    // not pending, or a split with no live leg, would make this test vacuous).
    expect(deleted).toBeTruthy();
    expect(upcoming).toBeTruthy();
    expect((await transferOverview(pool, b.budgetId)).pending.get(pendingRow)).toBe('outside');
  });

  afterAll(async () => {
    await cleanupFixtures();
  });

  test('the SQL asks about exactly the rows the shared rule calls needs_category', async () => {
    const { pending } = await transferOverview(pool, b.budgetId);
    const asked = await runCandidates(
      pool,
      b.budgetId,
      [...pending.keys()],
      MAX_ATTEMPTS,
      crypto.randomUUID(),
      ALL_ROWS,
      [],
    );
    const oracle = (await oracleInputs(b.budgetId, pending)).filter((row) => needsCategory(row.input));
    // The plain row, the zero amount, the pointer at an off-budget account, the
    // pointer at another budget's on-budget account, the pointer at the row's
    // own account and the payee that points off budget. Everything else above
    // is excluded. Outflows only: the run ALSO asks about an inflow that has a
    // counterpart, which the shared rule deliberately calls "no category", so
    // the agreement is scoped to the outflows both rules describe.
    expect(oracle).toHaveLength(6);
    const outflows = asked.filter((row) => row.amount <= 0);
    expect(outflows.map((row) => row.transaction_id).sort()).toEqual(oracle.map((row) => row.id).sort());
  });

  test('rows of off-budget, closed and deleted accounts are never asked about', async () => {
    const asked = await runCandidates(
      pool,
      b.budgetId,
      await pendingTransferIds(pool, b.budgetId),
      MAX_ATTEMPTS,
      crypto.randomUUID(),
      ALL_ROWS,
      [],
    );
    const ids = asked.map((row) => row.transaction_id);
    for (const id of hiddenAccounts) expect(ids).not.toContain(id);
  });

  test('a row already handed out is not offered again before its call settles', async () => {
    const all = await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, []);
    const taken = all.slice(0, 2).map((row) => row.transaction_id);
    const again = await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, taken);
    expect(again.map((row) => row.transaction_id)).toEqual(all.slice(2).map((row) => row.transaction_id));
  });
  test('an inflow is asked about only while another account holds its other leg', async () => {
    const savings = await newAccount(b.budgetId, 'Savings');
    const out = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-10', amount: -2500 });
    const into = await newTransaction({ budgetId: b.budgetId, accountId: savings, date: '2026-11-11', amount: 2500 });
    const alone = await newTransaction({ budgetId: b.budgetId, accountId: savings, date: '2026-11-12', amount: 9900 });

    const asked = await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, []);
    const ids = asked.map((row) => row.transaction_id);
    // Both sides of the movement are questions: either one may be confirmed.
    expect(ids).toContain(out);
    expect(ids).toContain(into);
    // Money in with nothing on the other side needs no category, so no question.
    expect(ids).not.toContain(alone);

    // "Not a transfer" already answered the only question an inflow can have.
    await pool.query(
      `insert into public.transfer_marks (transaction_id, budget_id, state) values ($1, $2, 'dismissed')`,
      [into, b.budgetId],
    );
    const after = await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, []);
    const afterIds = after.map((row) => row.transaction_id);
    expect(afterIds).not.toContain(into);
    // The outflow still needs a category, so it is asked as before.
    expect(afterIds).toContain(out);
  });

  test('V1: an inflow is asked about only while another account holds a free leg, by the link rule', async () => {
    const savings = await newAccount(b.budgetId, 'Savings');
    const card = await newAccount(b.budgetId, 'Card');
    const out = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-10', amount: -1900 });
    const leg = await newTransaction({ budgetId: b.budgetId, accountId: card, date: '2026-11-10', amount: 1900 });
    await pool.query(
      'update public.transactions set transfer_account_id = $2, transfer_transaction_id = $3 where id = $1',
      [out, card, leg],
    );
    // Money in, same amount: the only leg it could pair with is already taken.
    const into = await newTransaction({ budgetId: b.budgetId, accountId: savings, date: '2026-11-11', amount: 1900 });

    const ids = async () =>
      (await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, [])).map(
        (row) => row.transaction_id,
      );
    expect(await ids()).not.toContain(into);

    // Free that leg and the same inflow becomes a question.
    await pool.query(
      'update public.transactions set transfer_account_id = null, transfer_transaction_id = null where id = any($1::uuid[])',
      [[out, leg]],
    );
    expect(await ids()).toContain(into);
  });

  test('V2: only an inflow of an on-budget account is a transfer question, and no off-budget account is offered', async () => {
    const broker = await newAccount(b.budgetId, 'Broker', { onBudget: false });
    const savings = await newAccount(b.budgetId, 'Savings');
    // Money moving inside the off-budget account is "just a transaction" here.
    const left = await newTransaction({ budgetId: b.budgetId, accountId: broker, date: '2026-11-12', amount: -2700 });
    const right = await newTransaction({ budgetId: b.budgetId, accountId: broker, date: '2026-11-12', amount: 2700 });
    // A real pair: out of checking, into savings.
    const out = await newTransaction({ budgetId: b.budgetId, accountId: b.accountId, date: '2026-11-12', amount: -2700 });
    const into = await newTransaction({ budgetId: b.budgetId, accountId: savings, date: '2026-11-12', amount: 2700 });

    const asked = (
      await runCandidates(pool, b.budgetId, [], MAX_ATTEMPTS, crypto.randomUUID(), ALL_ROWS, [])
    ).map((row) => row.transaction_id);
    expect(asked).not.toContain(left);
    expect(asked).not.toContain(right);
    expect(asked).toContain(out);
    expect(asked).toContain(into);

    const ids = (await openAccounts(pool, b.budgetId)).map((account) => account.id);
    expect(ids).toContain(b.accountId);
    expect(ids).toContain(savings);
    expect(ids).not.toContain(broker);
    // Every offered account is one the register accepts as a transfer's other
    // side: open and counted by the budget.
    const { rows } = await pool.query<{ id: string }>(
      `select id from public.accounts
        where budget_id = $1 and deleted = false and closed = false and on_budget = true`,
      [b.budgetId],
    );
    expect(ids.sort()).toEqual(rows.map((row) => row.id).sort());
  });
});
