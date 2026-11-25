/**
 * Transfers written COMPLETE by every writer (budget-nq2f, transfers T3): repeat
 * rules, budget copies (fresh start), and the repair of half-linked rows older
 * writers left behind (report first, `--apply`, idempotent). A complete transfer
 * is two live rows pointing at each other and at each other's account, each
 * with the peer account's transfer payee, no category between two on-budget
 * accounts; balances follow the ledger. DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '../../catalog';
import { pool, withTransaction } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { makeOpCaller } from '../../core/test-op';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import budget from '..';
import { ensureTransferPayee } from '../domain/transfer-payees';
import { repairTransferPayees } from '../domain/transfer-payee-repair';

const user: IdentityUser = { id: crypto.randomUUID(), email: 'nq2f-complete@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const budgets: string[] = [];
const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function newBudget(name: string) {
  const id = crypto.randomUUID();
  budgets.push(id);
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [id, name, user.id]);
  await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, user.id]);
  const group = crypto.randomUUID();
  const category = crypto.randomUUID();
  await pool.query('INSERT INTO category_groups (id, budget_id, name) VALUES ($1,$2,$3)', [group, id, 'G']);
  await pool.query('INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1,$2,$3,$4)', [category, id, group, 'Gifts']);
  return { id, category };
}
async function account(b: string, name: string, over: { on_budget?: boolean; linked?: boolean } = {}) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget, direct_import_linked) VALUES ($1,$2,$3,'checking','CASH',$4,$5)`,
    [id, b, name, over.on_budget ?? true, over.linked ?? false],
  );
  await withTransaction(pool, (c) => ensureTransferPayee(c, b, id));
  return id;
}
const payeeOf = async (accountId: string) => (await pool.query('SELECT transfer_payee_id AS id FROM accounts WHERE id = $1', [accountId])).rows[0].id as string;
const nameOf = async (id: string | null) => (id ? ((await pool.query('SELECT name FROM payees WHERE id = $1', [id])).rows[0]?.name as string) : null);

interface Txn {
  id: string;
  account_id: string;
  amount: number;
  date: string;
  cleared: string;
  upcoming: boolean;
  deleted: boolean;
  payee_id: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  repeat_rule_id: string | null;
  import_id: string | null;
}
const txns = async (b: string, ...accounts: string[]): Promise<Txn[]> =>
  (
    await pool.query<Txn>(
      `SELECT id, account_id, amount::int AS amount, date::text AS date, cleared, upcoming, deleted, payee_id, category_id,
              transfer_account_id, transfer_transaction_id, repeat_rule_id, import_id
       FROM transactions WHERE budget_id = $1 AND ($2::uuid[] IS NULL OR account_id = ANY($2)) ORDER BY date, amount, id`,
      [b, accounts.length ? accounts : null],
    )
  ).rows;
const get = async (id: string): Promise<Txn> =>
  (
    await pool.query<Txn>(
      `SELECT id, account_id, amount::int AS amount, date::text AS date, cleared, upcoming, deleted, payee_id, category_id,
              transfer_account_id, transfer_transaction_id, repeat_rule_id, import_id FROM transactions WHERE id = $1`,
      [id],
    )
  ).rows[0]!;
const balances = async (id: string) => {
  const r = (await pool.query('SELECT cleared_balance AS c, uncleared_balance AS u FROM accounts WHERE id = $1', [id])).rows[0];
  return [Number(r.c), Number(r.u)];
};
async function expectLedgerConsistent(...ids: string[]) {
  for (const id of ids) {
    const fresh = (
      await pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE cleared <> 'uncleared'), 0) AS c,
                COALESCE(SUM(amount) FILTER (WHERE cleared = 'uncleared'), 0) AS u
         FROM transactions WHERE account_id = $1 AND NOT deleted AND NOT upcoming`,
        [id],
      )
    ).rows[0];
    expect(await balances(id)).toEqual([Number(fresh.c), Number(fresh.u)]);
  }
}
/** Both legs point at each other and at each other's account, with the peer's transfer payee. */
async function expectComplete(a: Txn, b: Txn) {
  expect(a.transfer_transaction_id).toBe(b.id);
  expect(b.transfer_transaction_id).toBe(a.id);
  expect(a.transfer_account_id).toBe(b.account_id);
  expect(b.transfer_account_id).toBe(a.account_id);
  expect(a.amount).toBe(-b.amount);
  expect(a.payee_id).toBe(await payeeOf(b.account_id));
  expect(b.payee_id).toBe(await payeeOf(a.account_id));
}
const rawTxn = async (b: string, accountId: string, over: Record<string, unknown>) => {
  const r = {
    date: iso(-1),
    amount: -100_000,
    payee_id: null,
    category_id: null,
    cleared: 'cleared',
    transfer_account_id: null,
    transfer_transaction_id: null,
    import_id: null,
    upcoming: false,
    ...over,
  };
  return (
    await pool.query<{ id: string }>(
      `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, category_id, cleared, approved, repeat, deleted,
         transfer_account_id, transfer_transaction_id, import_id, upcoming)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,'never',false,$8,$9,$10,$11) RETURNING id`,
      [b, accountId, r.date, r.amount, r.payee_id, r.category_id, r.cleared, r.transfer_account_id, r.transfer_transaction_id, r.import_id, r.upcoming],
    )
  ).rows[0]!.id;
};

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
});
afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

const generate = (b: string) => op('budget_repeat_rules_generate', { budget_id: b });

describe.skipIf(!dbReady)('repeat rules: pending occurrences stay as they are, the pair is written when they become real', () => {
  const makeRule = (b: string, accountId: string, payee: string, cat: string | null, days: number, outflow = 100_000) =>
    op('budget_repeat_rules_create', {
      budget_id: b,
      account_id: accountId,
      payee,
      category_id: cat,
      memo: 'rent',
      outflow,
      inflow: 0,
      frequency: 'monthly',
      next_due_date: iso(days),
    });
  /** Make the occurrences due `days` ago-or-today so the next generation flips them. */
  const dueNow = (b: string, from: string) =>
    pool.query('UPDATE transactions SET date = $2::date, occurrence_date = $2::date WHERE budget_id = $1 AND date = $3::date AND upcoming', [b, iso(0), from]);

  test('pending occurrences are single rows as on main (no mirror, no pointers, no balance); when one becomes real it is a complete transfer, a leg to an off-budget account keeps its category', async () => {
    const { id: b, category } = await newBudget('nq2f-repeat');
    const rent = await account(b, 'Rent Home');
    const savings = await account(b, 'Rent Savings');
    const house = await account(b, 'Rent House', { on_budget: false });
    expect((await makeRule(b, rent, 'Transfer : Rent Savings', category, 1)).status).toBe(201);
    expect((await makeRule(b, rent, 'Transfer : Rent House', category, 1)).status).toBe(201);

    const pending = await txns(b);
    expect(pending.length).toBeGreaterThanOrEqual(6);
    for (const t of pending) {
      expect(t).toMatchObject({ upcoming: true, account_id: rent, transfer_account_id: null, transfer_transaction_id: null });
      expect(t.category_id).toBe(category); // exactly as main writes it
    }
    for (const id of [rent, savings, house]) expect(await balances(id)).toEqual([0, 0]);
    expect((await generate(b)).json).toMatchObject({ created: 0 }); // idempotent

    await dueNow(b, iso(1));
    expect((await generate(b)).json).toMatchObject({ flipped: 2 });
    const real = (await txns(b)).filter((t) => !t.upcoming);
    expect(real).toHaveLength(4); // 2 legs + 2 mirrors
    const toSavings = real.find((t) => t.account_id === rent && t.transfer_account_id === savings)!;
    const toHouse = real.find((t) => t.account_id === rent && t.transfer_account_id === house)!;
    await expectComplete(toSavings, await get(toSavings.transfer_transaction_id!));
    expect(toSavings.category_id).toBeNull();
    await expectComplete(toHouse, await get(toHouse.transfer_transaction_id!));
    expect(toHouse.category_id).toBe(category); // off-budget peer: keeps its category
    expect(await balances(rent)).toEqual([0, -200_000]);
    expect(await balances(savings)).toEqual([0, 100_000]);
    expect(await balances(house)).toEqual([0, 100_000]);
    await expectLedgerConsistent(rent, savings, house);
    // The still-pending future occurrences have no mirror.
    expect((await txns(b)).filter((t) => t.upcoming).every((t) => t.transfer_transaction_id === null)).toBe(true);
    // Idempotent: nothing more to flip, no second mirror.
    expect((await generate(b)).json).toMatchObject({ flipped: 0 });
    expect((await txns(b)).filter((t) => !t.upcoming)).toHaveLength(4);
  });

  test('editing a pending transfer occurrence makes it real and writes its mirror; the ordinary balance rules of the detach hold', async () => {
    const { id: b } = await newBudget('nq2f-repeat-edit');
    const home = await account(b, 'Edit Home');
    const peer = await account(b, 'Edit Peer');
    const rule = (await makeRule(b, home, 'Transfer : Edit Peer', null, 2, 50_000)).json.id as string;
    const [first] = (await txns(b, home)).filter((t) => t.repeat_rule_id === rule);
    expect(first!.transfer_transaction_id).toBeNull();
    expect((await txns(b, peer))).toHaveLength(0);
    expect((await op('budget_transactions_update', { id: first!.id, budget_id: b, patch: { memo: 'edited' } })).status).toBe(204);
    const leg = await get(first!.id);
    expect(leg).toMatchObject({ upcoming: false, repeat_rule_id: null });
    const mirror = await get(leg.transfer_transaction_id!);
    await expectComplete(leg, mirror);
    expect(mirror).toMatchObject({ upcoming: false, repeat_rule_id: null, account_id: peer });
    expect(await balances(home)).toEqual([0, -50_000]);
    expect(await balances(peer)).toEqual([0, 50_000]);
    await expectLedgerConsistent(home, peer);
  });

  test('a transfer payee whose account cannot receive the transfer flips as on main: no mirror, nothing fails', async () => {
    const { id: b } = await newBudget('nq2f-repeat-closed');
    const home = await account(b, 'Closed Home');
    const gone = await account(b, 'Closed Peer');
    expect((await makeRule(b, home, 'Transfer : Closed Peer', null, 1, 10_000)).status).toBe(201);
    await pool.query('UPDATE accounts SET closed = true WHERE id = $1', [gone]);
    await dueNow(b, iso(1));
    expect((await generate(b)).json).toMatchObject({ flipped: 1 });
    expect((await txns(b, gone))).toHaveLength(0);
    const flipped = (await txns(b, home)).filter((t) => !t.upcoming);
    expect(flipped).toHaveLength(1);
    expect(flipped[0]!.transfer_transaction_id).toBeNull();
    expect(await balances(home)).toEqual([0, -10_000]);
  });
});

describe.skipIf(!dbReady)('a budget copy (fresh start) behaves as on main', () => {
  test('rows and balances are copied as main copies them: unlinked accounts start at 0, no leg is invented in them, no pointer is rewritten', async () => {
    const { id: b, category } = await newBudget('nq2f-copy');
    const a1 = await account(b, 'Copy Linked A', { linked: true });
    const a2 = await account(b, 'Copy Linked B', { linked: true });
    const c = await account(b, 'Copy Unlinked C');
    const payee = { a1: await payeeOf(a1), a2: await payeeOf(a2), c: await payeeOf(c) };
    await pool.query('UPDATE accounts SET cleared_balance = -900000 WHERE id = $1', [a1]);
    await pool.query('UPDATE accounts SET cleared_balance = 900000 WHERE id = $1', [a2]);
    // A1 -> A2 (a complete pair), A1 -> C (C is not carried), three of 100000 from A1 to C, C spent 250000.
    const x1 = await rawTxn(b, a1, { amount: -300_000, payee_id: payee.a2, transfer_account_id: a2 });
    const x2 = await rawTxn(b, a2, { amount: 300_000, payee_id: payee.a1, transfer_account_id: a1, transfer_transaction_id: x1 });
    await pool.query('UPDATE transactions SET transfer_transaction_id = $2 WHERE id = $1', [x1, x2]);
    for (let k = 0; k < 3; k++) {
      const y1 = await rawTxn(b, a1, { amount: -100_000, payee_id: payee.c, transfer_account_id: c, date: iso(-10 - k) });
      const y2 = await rawTxn(b, c, { amount: 100_000, payee_id: payee.a1, transfer_account_id: a1, transfer_transaction_id: y1, date: iso(-10 - k) });
      await pool.query('UPDATE transactions SET transfer_transaction_id = $2 WHERE id = $1', [y1, y2]);
    }
    await rawTxn(b, c, { amount: -250_000, payee_id: null, date: iso(-5) });
    await pool.query('UPDATE transactions SET category_id = $2 WHERE id = $1', [x1, category]);
    await pool.query('UPDATE accounts SET cleared_balance = 50000 WHERE id = $1', [c]);

    const res = await op('budget_fresh_start', { budget_id: b });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const nb = res.json.created.id as string;
    budgets.push(nb);
    const accounts = (await pool.query('SELECT name, cleared_balance::int AS c, uncleared_balance::int AS u FROM accounts WHERE budget_id = $1 ORDER BY name', [nb])).rows;
    // Linked accounts keep their balance, the unlinked one starts at 0: main's rule.
    expect(accounts).toEqual([
      { name: 'Copy Linked A', c: -900_000, u: 0 },
      { name: 'Copy Linked B', c: 900_000, u: 0 },
      { name: 'Copy Unlinked C', c: 0, u: 0 },
    ]);
    const newC = (await pool.query('SELECT id FROM accounts WHERE budget_id = $1 AND name = $2', [nb, 'Copy Unlinked C'])).rows[0].id as string;
    expect(await txns(nb, newC)).toEqual([]); // no other leg is copied into it
    const rows = await txns(nb);
    expect(rows).toHaveLength(5); // the carried accounts' rows only (1 + 3 + 1 of A1/A2)
    // Rows are as main copies them: the account pointer mapped, the transaction pointer NULL, the category kept.
    for (const r of rows) expect(r.transfer_transaction_id).toBeNull();
    expect(rows.filter((r) => r.transfer_account_id !== null)).toHaveLength(5);
    expect(rows.find((r) => r.amount === -300_000)!.category_id).not.toBeNull();
  });
});

describe.skipIf(!dbReady)('a budget copy writes nothing main does not', () => {
  test('an account whose pointer names another account\'s payee gets no new payee in the copy', async () => {
    const { id: b } = await newBudget('nq2f-copy-badptr');
    const x = await account(b, 'Bad X');
    const y = await account(b, 'Bad Y');
    const ownPayee = await payeeOf(x);
    await pool.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [await payeeOf(y), x]);
    await pool.query('DELETE FROM payees WHERE id = $1', [ownPayee]); // no payee points at X any more
    const oldCount = (await pool.query('SELECT count(*)::int AS n FROM payees WHERE budget_id = $1', [b])).rows[0].n;
    const res = await op('budget_fresh_start', { budget_id: b });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const nb = res.json.created.id as string;
    budgets.push(nb);
    expect((await pool.query('SELECT count(*)::int AS n FROM payees WHERE budget_id = $1', [nb])).rows[0].n).toBe(oldCount);
    const ptr = (await pool.query('SELECT a.name, p.name AS payee FROM accounts a JOIN payees p ON p.id = a.transfer_payee_id WHERE a.budget_id = $1 ORDER BY a.name', [nb])).rows;
    expect(ptr).toEqual([{ name: 'Bad X', payee: 'Transfer : Bad Y' }, { name: 'Bad Y', payee: 'Transfer : Bad Y' }]);
    expect((await pool.query("SELECT count(*)::int AS n FROM payees WHERE budget_id = $1 AND name = 'Transfer : Bad X'", [nb])).rows[0].n).toBe(0);
  });
});

describe.skipIf(!dbReady)('repair of half-linked transfer rows: report first, --apply, idempotent', () => {
  const repair = (b: string, apply: boolean, createMirrors = false) =>
    withTransaction(pool, (c) => repairTransferPayees(c, b, { apply, createMirrors }));

  test('a restored pair (transaction pointers only, a category, a missing payee) is completed; reading never rewrites it', async () => {
    const { id: b, category } = await newBudget('nq2f-fix-pointers');
    const a = await account(b, 'Fix A');
    const c = await account(b, 'Fix B');
    const x1 = await rawTxn(b, a, { amount: -70_000, payee_id: await payeeOf(c), category_id: category });
    const x2 = await rawTxn(b, c, { amount: 70_000, category_id: category });
    await pool.query('UPDATE transactions SET transfer_transaction_id = $2 WHERE id = $1', [x1, x2]);
    await pool.query('UPDATE transactions SET transfer_transaction_id = $2 WHERE id = $1', [x2, x1]);
    const before = await txns(b);

    const report = await repair(b, false);
    expect(report.half_linked).toMatchObject({ complete_pointers: 2, set_payee: 1, clear_category: 2, paired: 0, needs_mirror: 0 });
    expect(await txns(b)).toEqual(before); // nothing rewritten by a read, nor by the report

    const applied = await repair(b, true);
    expect(applied.half_linked).toMatchObject({ complete_pointers: 2, set_payee: 1, clear_category: 2 });
    const [r1, r2] = [await get(x1), await get(x2)];
    await expectComplete(r1, r2);
    expect([r1.category_id, r2.category_id]).toEqual([null, null]);
    const again = await repair(b, true);
    expect(again.half_linked).toMatchObject({ complete_pointers: 0, set_payee: 0, clear_category: 0, paired: 0, needs_mirror: 0, ambiguous: 0 });
  });

  test('a copy-style pair (account pointers only) is paired once, without moving a balance', async () => {
    const { id: b } = await newBudget('nq2f-fix-copy');
    const a = await account(b, 'Cp A');
    const c = await account(b, 'Cp B');
    const x1 = await rawTxn(b, a, { amount: -90_000, payee_id: await payeeOf(c), transfer_account_id: c });
    const x2 = await rawTxn(b, c, { amount: 90_000, payee_id: await payeeOf(a), transfer_account_id: a });
    await pool.query('UPDATE accounts SET cleared_balance = -90000 WHERE id = $1', [a]);
    await pool.query('UPDATE accounts SET cleared_balance = 90000 WHERE id = $1', [c]);
    const report = await repair(b, false);
    expect(report.half_linked).toMatchObject({ paired: 1, needs_mirror: 0, ambiguous: 0 });
    await repair(b, true);
    await expectComplete(await get(x1), await get(x2));
    expect(await balances(a)).toEqual([-90_000, 0]);
    expect(await balances(c)).toEqual([90_000, 0]);
    expect((await repair(b, true)).half_linked).toMatchObject({ paired: 0 });
  });

  test('a payee-only leg is paired with the bank row that is its other side (Undo-able), else listed; mirrors only when asked', async () => {
    const { id: b } = await newBudget('nq2f-fix-payee-only');
    const a = await account(b, 'Po A');
    const c = await account(b, 'Po B');
    const bankPayee = (await pool.query<{ id: string }>(`INSERT INTO payees (budget_id, name) VALUES ($1,'PIX recebido') RETURNING id`, [b])).rows[0]!.id;
    const leg = await rawTxn(b, a, { amount: -120_000, payee_id: await payeeOf(c), date: iso(-3) });
    const bank = await rawTxn(b, c, { amount: 120_000, payee_id: bankPayee, import_id: 'bank:po1', date: iso(-2) });
    const lonely = await rawTxn(b, a, { amount: -33_000, payee_id: await payeeOf(c), date: iso(-1) });
    const twinA = await rawTxn(b, a, { amount: -44_000, payee_id: await payeeOf(c), date: iso(-1) });
    await rawTxn(b, c, { amount: 44_000, payee_id: bankPayee, import_id: 'bank:po2', date: iso(-2) });
    await rawTxn(b, c, { amount: 44_000, payee_id: bankPayee, import_id: 'bank:po3', date: iso(0) });
    await pool.query('UPDATE accounts SET cleared_balance = -197000 WHERE id = $1', [a]);
    await pool.query('UPDATE accounts SET cleared_balance = 208000 WHERE id = $1', [c]);

    const report = await repair(b, false);
    expect(report.half_linked).toMatchObject({ paired: 1, needs_mirror: 1, ambiguous: 1 });
    expect(report.half_linked.items.find((i) => i.kind === 'needs_mirror')!.transaction_id).toBe(lonely);
    expect(report.half_linked.items.find((i) => i.kind === 'ambiguous')!.transaction_id).toBe(twinA);

    await repair(b, true);
    await expectComplete(await get(leg), await get(bank));
    expect((await get(lonely)).transfer_transaction_id).toBeNull(); // no mirror unless asked
    expect((await get(twinA)).transfer_transaction_id).toBeNull(); // never guessed
    expect(await balances(a)).toEqual([-197_000, 0]);
    expect(await balances(c)).toEqual([208_000, 0]);
    // The bank row keeps what it was, so taking the leg out of the pair restores it (R1 path).
    const link = (await pool.query('SELECT prev_payee_id FROM transfer_links WHERE transaction_id = $1', [bank])).rows[0];
    expect(link.prev_payee_id).toBe(bankPayee);
    expect((await op('budget_transactions_update', { id: leg, budget_id: b, patch: { payee: 'Padaria' } })).status).toBe(204);
    expect(await get(bank)).toMatchObject({ transfer_transaction_id: null, deleted: false, payee_id: bankPayee, import_id: 'bank:po1' });

    // Second run: only the decisions are left; then the mirror is created on request and the peer balance moves.
    const second = await repair(b, true);
    expect(second.half_linked).toMatchObject({ paired: 0, needs_mirror: 1, ambiguous: 1, mirrors_created: 0 });
    const made = await repair(b, true, true);
    expect(made.half_linked.mirrors_created).toBe(1);
    const lonelyAfter = await get(lonely);
    const mirror = await get(lonelyAfter.transfer_transaction_id!);
    await expectComplete(lonelyAfter, mirror);
    expect(await balances(c)).toEqual([241_000, 0]); // the mirror moved the peer account by its amount
    expect(mirror).toMatchObject({ account_id: c, amount: 33_000, upcoming: false });
    expect((await repair(b, true, true)).half_linked).toMatchObject({ needs_mirror: 0, mirrors_created: 0 });
  });

  test('a pair the repair made can be undone with POST /transfers/unlink: both legs get back what they were', async () => {
    const { id: b } = await newBudget('nq2f-fix-unlink');
    const a = await account(b, 'Un A');
    const c = await account(b, 'Un B');
    const bankPayee = (await pool.query<{ id: string }>(`INSERT INTO payees (budget_id, name) VALUES ($1,'PIX recebido') RETURNING id`, [b])).rows[0]!.id;
    const legPayee = await payeeOf(c);
    const leg = await rawTxn(b, a, { amount: -120_000, payee_id: legPayee, date: iso(-2) });
    const bank = await rawTxn(b, c, { amount: 120_000, payee_id: bankPayee, import_id: 'bank:un1', date: iso(-2) });
    await repair(b, true);
    await expectComplete(await get(leg), await get(bank));
    const records = (await pool.query('SELECT transaction_id FROM transfer_links WHERE budget_id = $1', [b])).rows.map((r) => r.transaction_id).sort();
    expect(records).toEqual([leg, bank].sort()); // a record on BOTH legs

    const undo = await op('budget_transfers_unlink', { budget_id: b, transaction_ids: [bank] });
    expect(undo.json).toMatchObject({ unlinked: 1 });
    expect(await get(bank)).toMatchObject({ payee_id: bankPayee, transfer_account_id: null, transfer_transaction_id: null, import_id: 'bank:un1' });
    // The leg is back to what the repair found: the transfer payee, no pointers (listed again by the report).
    expect(await get(leg)).toMatchObject({ payee_id: legPayee, transfer_account_id: null, transfer_transaction_id: null });
  });
});
