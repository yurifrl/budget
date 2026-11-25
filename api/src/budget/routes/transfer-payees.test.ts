/**
 * Transfer payee lifecycle (budget-upgg, transfers T2): every account has
 * exactly one system payee "Transfer : <account>", found by id.
 *
 *   - lifecycle: created with the account (create, restore, budget copy),
 *     renamed with it in the same transaction, kept when it is closed;
 *   - repair: duplicates and name-only payees folded into the canonical one,
 *     transactions and rules moved, a read-only report first, idempotent;
 *   - protection: the payee endpoints refuse to rename, merge, hide or delete it;
 *     renaming rules stay allowed;
 *   - listing: GET /payees names the account, on request;
 *   - resolution: payee TEXT reaches the account's canonical payee, never a guess.
 *
 * In-process through app.request(); DB-gated like the other route suites.
 * Every test makes its own budget and the budgets are deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';

let pool: Pool | null = null;
let dbReady = false;
try {
  pool = (await import('../../core/db')).pool;
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.transactions')::text as t")).rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'transfer-payees@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError((await import('../../core/validate')).httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/accounts', (await import('./accounts')).default);
app.route('/payees', (await import('./payees')).default);
app.route('/transactions', (await import('./transactions')).default);
app.route('/restore', (await import('./budget-restore')).default);
app.route('/budgets', (await import('./budgets')).default);

const budgets: string[] = [];

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function newBudget(): Promise<string> {
  const id = crypto.randomUUID();
  await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [id, 'xfer-payees', userId]);
  budgets.push(id);
  return id;
}

async function createAccount(budgetId: string, name: string, extra: Record<string, unknown> = {}): Promise<string> {
  const res = await send('POST', '/accounts', { budget_id: budgetId, name, type: 'checking', on_budget: true, balance: 0, ...extra });
  expect(res.status, await res.clone().text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** An account written the way old data has it: no transfer payee at all. */
async function legacyAccount(budgetId: string, name: string): Promise<string> {
  const id = crypto.randomUUID();
  await pool!.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1, $2, $3, 'checking', 'CASH', true)`,
    [id, budgetId, name],
  );
  return id;
}

async function rawPayee(budgetId: string, name: string, accountId: string | null = null, extra: { rule?: [string, string]; hidden?: boolean } = {}) {
  const res = await pool!.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name, transfer_account_id, hidden, rename_match_type, rename_condition)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [budgetId, name, accountId, extra.hidden ?? false, extra.rule?.[0] ?? null, extra.rule?.[1] ?? null],
  );
  return res.rows[0]!.id;
}

async function rawTxn(budgetId: string, accountId: string, payeeId: string | null, amount = -1000) {
  const res = await pool!.query<{ id: string }>(
    `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted)
     VALUES ($1, $2, '2026-01-05', $3, $4, 'uncleared', true, 'never', false) RETURNING id`,
    [budgetId, accountId, amount, payeeId],
  );
  return res.rows[0]!.id;
}

const linkedPayees = async (accountId: string) =>
  (await pool!.query<{ id: string; name: string; deleted: boolean }>(
    'SELECT id, name, deleted FROM payees WHERE transfer_account_id = $1 ORDER BY created_at, id',
    [accountId],
  )).rows;
const accountPointer = async (accountId: string) =>
  (await pool!.query<{ transfer_payee_id: string | null }>('SELECT transfer_payee_id FROM accounts WHERE id = $1', [accountId])).rows[0]!
    .transfer_payee_id;
const payeeIdOf = async (txnId: string) =>
  (await pool!.query<{ payee_id: string | null }>('SELECT payee_id FROM transactions WHERE id = $1', [txnId])).rows[0]!.payee_id;
const payeeExists = async (id: string) => (await pool!.query('SELECT 1 FROM payees WHERE id = $1', [id])).rowCount === 1;

/** The invariant: one live payee points at the account, it has the expected name, and the account points back. */
async function expectOneTransferPayee(accountId: string, name: string) {
  const linked = await linkedPayees(accountId);
  expect(linked.map((p) => p.name)).toEqual([name]);
  expect(linked[0]!.deleted).toBe(false);
  expect(await accountPointer(accountId)).toBe(linked[0]!.id);
  return linked[0]!.id;
}

const txnBody = (accountId: string, payee: string, over: Record<string, unknown> = {}) => ({
  account_id: accountId,
  date: '2026-01-06',
  payee,
  category_id: null,
  memo: '',
  outflow: 1000,
  inflow: 0,
  cleared: 'uncleared',
  approved: true,
  flag: null,
  repeat: 'never',
  ...over,
});

async function createTransfer(budgetId: string, fromAccountId: string, payee: string) {
  const res = await send('POST', '/transactions', { budget_id: budgetId, txn: txnBody(fromAccountId, payee) });
  const text = await res.text();
  return { res, text, body: res.status === 201 ? (JSON.parse(text) as { id: string; payee_id: string; transfer_account_id: string }) : null };
}

beforeAll(async () => {
  if (!dbReady) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [userId, user.email]);
});

afterAll(async () => {
  if (!dbReady) return;
  await pool!.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool!.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe.skipIf(!dbReady)('lifecycle: created with the account, renamed with it, kept when closed', () => {
  test('creating an account creates exactly one linked transfer payee with the right name', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'Life Main');
    await expectOneTransferPayee(a, 'Transfer : Life Main');
  });

  test('two accounts with the same name each get their own payee, and each is found by its own id', async () => {
    const b = await newBudget();
    const first = await createAccount(b, 'Same Name');
    const second = await createAccount(b, 'Same Name');
    const firstPayee = await expectOneTransferPayee(first, 'Transfer : Same Name');
    const secondPayee = await expectOneTransferPayee(second, 'Transfer : Same Name (2)');
    expect(firstPayee).not.toBe(secondPayee);

    // A third account (the register's "from" side) transfers to each by its payee name.
    const from = await createAccount(b, 'Same From');
    const toFirst = await createTransfer(b, from, 'Transfer : Same Name');
    const toSecond = await createTransfer(b, from, 'Transfer : Same Name (2)');
    expect(toFirst.body!.transfer_account_id).toBe(first);
    expect(toFirst.body!.payee_id).toBe(firstPayee);
    expect(toSecond.body!.transfer_account_id).toBe(second);
    expect(toSecond.body!.payee_id).toBe(secondPayee);
  });

  test('renaming the account renames its transfer payee in place: same id, one payee, no stale name', async () => {
    const b = await newBudget();
    const other = await createAccount(b, 'Ren Other');
    const a = await createAccount(b, 'Ren Old');
    const payeeId = await expectOneTransferPayee(a, 'Transfer : Ren Old');
    const before = await createTransfer(b, other, 'Transfer : Ren Old');

    const res = await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'Ren New' });
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await expectOneTransferPayee(a, 'Transfer : Ren New')).toBe(payeeId);
    expect((await pool!.query("SELECT 1 FROM payees WHERE budget_id = $1 AND name = 'Transfer : Ren Old'", [b])).rowCount).toBe(0);
    // The row made before the rename still points at the same payee and account.
    expect(await payeeIdOf(before.body!.id)).toBe(payeeId);
    // New transfers by the new name reach the same account and payee.
    const after = await createTransfer(b, other, 'Transfer : Ren New');
    expect(after.body!.payee_id).toBe(payeeId);
    expect(after.body!.transfer_account_id).toBe(a);
  });

  test('a stale name cannot pick the wrong account: a new account that takes the old name gets its own payee', async () => {
    const b = await newBudget();
    const other = await createAccount(b, 'Stale Other');
    const renamed = await createAccount(b, 'Stale Old');
    await send('PATCH', `/accounts/${renamed}`, { budget_id: b, name: 'Stale New' });
    const newcomer = await createAccount(b, 'Stale Old');
    await expectOneTransferPayee(newcomer, 'Transfer : Stale Old');
    const t = await createTransfer(b, other, 'Transfer : Stale Old');
    expect(t.body!.transfer_account_id).toBe(newcomer);
    await expectOneTransferPayee(renamed, 'Transfer : Stale New');
  });

  test('renaming onto a name held by a leftover name-only payee folds it in and keeps its transactions', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'Fold Old');
    const leftover = await rawPayee(b, 'Transfer : Fold Target');
    const peer = await legacyAccount(b, 'Fold Peer');
    const row = await rawTxn(b, peer, leftover);

    const res = await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'Fold Target' });
    expect(res.status, await res.clone().text()).toBe(200);

    const payeeId = await expectOneTransferPayee(a, 'Transfer : Fold Target');
    expect(await payeeExists(leftover)).toBe(false);
    expect(await payeeIdOf(row)).toBe(payeeId);
  });

  test('renaming onto the name of another account gives the renamed account the numbered variant', async () => {
    const b = await newBudget();
    const first = await createAccount(b, 'Clash First');
    const second = await createAccount(b, 'Clash Second');
    await send('PATCH', `/accounts/${second}`, { budget_id: b, name: 'Clash First' });
    await expectOneTransferPayee(first, 'Transfer : Clash First');
    await expectOneTransferPayee(second, 'Transfer : Clash First (2)');
  });

  test('closing and reopening the account keeps its transfer payee', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'Close Me');
    const payeeId = await expectOneTransferPayee(a, 'Transfer : Close Me');
    expect((await send('PATCH', `/accounts/${a}`, { budget_id: b, closed: true })).status).toBe(200);
    expect(await expectOneTransferPayee(a, 'Transfer : Close Me')).toBe(payeeId);
    expect((await send('PATCH', `/accounts/${a}`, { budget_id: b, closed: false, name: 'Reopened' })).status).toBe(200);
    expect(await expectOneTransferPayee(a, 'Transfer : Reopened')).toBe(payeeId);
  });

  test('restore creates one transfer payee per account, and transfer legs use the peer by id even with a shared name', async () => {
    const b = await newBudget();
    const leg = (accountIndex: number, peer: number, outflow: number, inflow: number) => ({
      accountIndex,
      date: '2026-02-01',
      payee: '',
      categoryIndex: null,
      memo: '',
      outflow,
      inflow,
      cleared: 'cleared',
      flag: '',
      transferPeerIndex: peer,
    });
    const res = await send('POST', `/restore?budget_id=${b}`, {
      groups: [],
      categories: [],
      accounts: [{ name: 'Twin' }, { name: 'Twin' }, { name: 'Hub' }],
      // 0: Twin#1 -> Hub (txn 1); 2: Twin#2 -> Hub (txn 3)
      transactions: [leg(0, 1, 5000, 0), leg(2, 0, 0, 5000), leg(1, 3, 7000, 0), leg(2, 2, 0, 7000)],
      assignments: [],
    });
    expect(res.status, await res.clone().text()).toBe(201);

    const accounts = (await pool!.query<{ id: string }>('SELECT id FROM accounts WHERE budget_id = $1', [b])).rows;
    expect(accounts).toHaveLength(3);
    for (const a of accounts) expect(await linkedPayees(a.id)).toHaveLength(1);
    const names = (await pool!.query<{ name: string }>('SELECT name FROM payees WHERE budget_id = $1 ORDER BY name', [b])).rows.map((r) => r.name);
    expect(names).toEqual(['Transfer : Hub', 'Transfer : Twin', 'Transfer : Twin (2)']);

    // Every transfer leg carries the transfer payee of the account on the OTHER side of its pair.
    const legs = await pool!.query<{ payee_account: string | null; peer_account: string }>(
      `SELECT p.transfer_account_id AS payee_account, peer.account_id AS peer_account
         FROM transactions t
         JOIN transactions peer ON peer.id = t.transfer_transaction_id
         LEFT JOIN payees p ON p.id = t.payee_id
        WHERE t.budget_id = $1`,
      [b],
    );
    expect(legs.rows).toHaveLength(4);
    for (const row of legs.rows) expect(row.payee_account).toBe(row.peer_account);
  });

  test('a fresh-start copy of a budget with duplicate and missing transfer payees has exactly one per account', async () => {
    const b = await newBudget();
    const dup = await legacyAccount(b, 'Copy Dup');
    const lone = await legacyAccount(b, 'Copy Lone');
    const keep = await rawPayee(b, 'Transfer : Copy Dup', dup);
    await rawPayee(b, 'Transfer : Copy Dup Renamed', dup);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, dup]);
    void lone;

    const res = await send('POST', '/budgets/fresh-start', { budget_id: b });
    expect(res.status, await res.clone().text()).toBe(200);
    const created = ((await res.json()) as { created: { id: string } }).created.id;
    budgets.push(created);

    const accounts = (await pool!.query<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE budget_id = $1', [created])).rows;
    expect(accounts.map((a) => a.name).sort()).toEqual(['Copy Dup', 'Copy Lone']);
    for (const a of accounts) await expectOneTransferPayee(a.id, `Transfer : ${a.name}`);
  });
});

describe.skipIf(!dbReady)('repair: one canonical payee per account, report first, idempotent', () => {
  /** A budget with every kind of damage; returns the ids the assertions need. */
  async function damagedBudget() {
    const b = await newBudget();
    const peer = await createAccount(b, 'Rep Peer');
    const one = await legacyAccount(b, 'Rep One');
    const two = await legacyAccount(b, 'Rep Two');
    const three = await legacyAccount(b, 'Rep Three');
    const four = await legacyAccount(b, 'Rep Four');
    const twin1 = await legacyAccount(b, 'Rep Twin');
    const twin2 = await legacyAccount(b, 'Rep Twin');
    void twin1;
    void twin2;

    // One: renamed once ("Rep Old" is the account's pointer), the new name was picked later.
    const oldPayee = await rawPayee(b, 'Transfer : Rep Old', one, { rule: ['contains', 'OLD-RULE'] });
    const newPayee = await rawPayee(b, 'Transfer : Rep One', one, { rule: ['contains', 'NEW-RULE'] });
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [oldPayee, one]);
    const oldRow = await rawTxn(b, peer, oldPayee);
    const newRow1 = await rawTxn(b, peer, newPayee);
    const newRow2 = await rawTxn(b, peer, newPayee);
    // Two: only a name-only payee (no link), with a rename rule and a transaction.
    const nameOnly = await rawPayee(b, 'Transfer : Rep Two', null, { rule: ['is', 'TWO-RULE'] });
    const nameOnlyRow = await rawTxn(b, peer, nameOnly);
    // Four: linked payee, hidden, account pointer missing.
    const four1 = await rawPayee(b, 'Transfer : Rep Four', four, { hidden: true });
    // Twin: a name-only payee that two accounts share: left alone.
    const ambiguous = await rawPayee(b, 'Transfer : Rep Twin', null);
    return { b, peer, one, two, three, four, oldPayee, newPayee, oldRow, newRow1, newRow2, nameOnly, nameOnlyRow, four1, ambiguous, twin1, twin2 };
  }

  const snapshot = async (b: string) => ({
    payees: (await pool!.query('SELECT id, name, deleted, hidden, transfer_account_id, rename_condition FROM payees WHERE budget_id = $1 ORDER BY id', [b])).rows,
    accounts: (await pool!.query('SELECT id, transfer_payee_id FROM accounts WHERE budget_id = $1 ORDER BY id', [b])).rows,
    txns: (await pool!.query('SELECT id, payee_id FROM transactions WHERE budget_id = $1 ORDER BY id', [b])).rows,
  });

  test('the report counts what would change and writes nothing, even in a READ ONLY transaction', async () => {
    const d = await damagedBudget();
    const { repairTransferPayees } = await import('../domain/transfer-payee-repair');
    const before = await snapshot(d.b);

    const client = await pool!.connect();
    let report;
    try {
      await client.query('BEGIN READ ONLY');
      report = await repairTransferPayees(client, d.b, { apply: false });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    expect(report.applied).toBe(false);
    expect(report.accounts_checked).toBe(7);
    // One: 2 payees -> 1 (2 new-name rows move, one rule is dropped because Old already has one);
    // Two: adopts the name-only payee; Three and the two Twins: a payee is created;
    // Four: pointer + hidden fixed.
    expect(report.accounts_with_duplicates).toBe(1);
    expect(report.accounts_without_payee).toBe(4);
    expect(report.name_only_payees).toBe(1);
    expect(report.ambiguous_name_only_payees).toBe(1);
    expect(report.payees_removed).toBe(1);
    expect(report.transactions_repointed).toBe(2);
    expect(report.rename_rules_dropped).toBe(1);
    expect(report.rename_rules_moved).toBe(0);
    expect(report.pointers_fixed).toBe(2);
    expect(report.payees_renamed).toBe(1);
    expect(await snapshot(d.b)).toEqual(before);
  });

  test('apply leaves one canonical payee per account, re-points transactions and rules, removes the extras', async () => {
    const d = await damagedBudget();
    const { repairTransferPayees } = await import('../domain/transfer-payee-repair');

    const planned = await repairTransferPayees(pool!, d.b, { apply: false });
    const applied = await repairTransferPayees(pool!, d.b, { apply: true });
    expect(applied.applied).toBe(true);
    expect({ ...applied, applied: false }).toEqual(planned);

    // One: the pointed payee ("Rep Old") survives, renamed; the later one is gone and its rows moved.
    expect(await expectOneTransferPayee(d.one, 'Transfer : Rep One')).toBe(d.oldPayee);
    expect(await payeeExists(d.newPayee)).toBe(false);
    expect(await payeeIdOf(d.oldRow)).toBe(d.oldPayee);
    expect(await payeeIdOf(d.newRow1)).toBe(d.oldPayee);
    expect(await payeeIdOf(d.newRow2)).toBe(d.oldPayee);
    const rule = (await pool!.query('SELECT rename_condition FROM payees WHERE id = $1', [d.oldPayee])).rows[0];
    expect(rule.rename_condition).toBe('OLD-RULE');
    // Two: the name-only payee became the account's payee, rows and rule kept.
    expect(await expectOneTransferPayee(d.two, 'Transfer : Rep Two')).toBe(d.nameOnly);
    expect(await payeeIdOf(d.nameOnlyRow)).toBe(d.nameOnly);
    expect((await pool!.query('SELECT rename_condition FROM payees WHERE id = $1', [d.nameOnly])).rows[0].rename_condition).toBe('TWO-RULE');
    // Three: created.
    await expectOneTransferPayee(d.three, 'Transfer : Rep Three');
    // Four: pointer set, payee visible again.
    expect(await expectOneTransferPayee(d.four, 'Transfer : Rep Four')).toBe(d.four1);
    expect((await pool!.query('SELECT hidden FROM payees WHERE id = $1', [d.four1])).rows[0].hidden).toBe(false);
    // Twins: each its own payee; the ambiguous name-only payee was left alone.
    expect(await payeeExists(d.ambiguous)).toBe(true);
    const twins = (await pool!.query<{ id: string }>("SELECT id FROM accounts WHERE budget_id = $1 AND name = 'Rep Twin'", [d.b])).rows;
    const twinPayees = new Set<string>();
    for (const t of twins) {
      const linked = await linkedPayees(t.id);
      expect(linked).toHaveLength(1);
      expect(await accountPointer(t.id)).toBe(linked[0]!.id);
      twinPayees.add(linked[0]!.id);
    }
    expect(twinPayees.size).toBe(2);

    // Idempotent: a second run has nothing to do.
    const again = await repairTransferPayees(pool!, d.b, { apply: true });
    expect(again.actions).toEqual([]);
    expect(again.payees_removed + again.transactions_repointed + again.pointers_fixed + again.payees_renamed).toBe(0);
    // The repair never touches another budget.
    expect((await pool!.query('SELECT count(*)::int AS n FROM payees WHERE budget_id = $1 AND transfer_account_id IS NOT NULL', [d.b])).rows[0].n).toBe(7);
  });

  test('a duplicate payee a rename left behind is repaired and the register uses the canonical one before the repair too', async () => {
    const b = await newBudget();
    const other = await legacyAccount(b, 'Dup Other');
    const a = await legacyAccount(b, 'Dup Acct');
    const canonical = await rawPayee(b, 'Transfer : Dup Acct', a);
    const stale = await rawPayee(b, 'Transfer : Dup Acct Stale', a);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [canonical, a]);
    // Typing the stale payee's name still lands on the account's canonical payee.
    const t = await createTransfer(b, other, 'Transfer : Dup Acct Stale');
    expect(t.res.status).toBe(201);
    expect(t.body!.payee_id).toBe(canonical);
    expect(t.body!.transfer_account_id).toBe(a);

    const { repairTransferPayees } = await import('../domain/transfer-payee-repair');
    await repairTransferPayees(pool!, b, { apply: true });
    expect(await payeeExists(stale)).toBe(false);
    await expectOneTransferPayee(a, 'Transfer : Dup Acct');
  });
});

describe.skipIf(!dbReady)('protection: the payee endpoints refuse to edit a transfer payee', () => {
  async function protectedBudget() {
    const b = await newBudget();
    const acc = await createAccount(b, 'Prot One');
    const acc2 = await createAccount(b, 'Prot Two');
    const payee = await expectOneTransferPayee(acc, 'Transfer : Prot One');
    const payee2 = await expectOneTransferPayee(acc2, 'Transfer : Prot Two');
    const ordinary = await rawPayee(b, 'Ordinary Shop');
    return { b, acc, acc2, payee, payee2, ordinary };
  }
  const expectProtected = async (res: Response, name: string) => {
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string; params?: { name: string } };
    expect(body.code).toBe('transfer_payee_protected');
    expect(body.params).toEqual({ name });
  };

  test('rename is refused with transfer_payee_protected', async () => {
    const p = await protectedBudget();
    await expectProtected(await send('PATCH', `/payees/${p.payee}/name?budget_id=${p.b}`, { name: 'Anything Else' }), 'Transfer : Prot One');
    expect((await pool!.query('SELECT name FROM payees WHERE id = $1', [p.payee])).rows[0].name).toBe('Transfer : Prot One');
  });

  test('merge is refused as the source and as the target, and moves nothing', async () => {
    const p = await protectedBudget();
    const row = await rawTxn(p.b, p.acc, p.ordinary);
    await expectProtected(await send('POST', `/payees/${p.payee}/merge?budget_id=${p.b}`, { target_id: p.ordinary }), 'Transfer : Prot One');
    await expectProtected(await send('POST', `/payees/${p.ordinary}/merge?budget_id=${p.b}`, { target_id: p.payee }), 'Transfer : Prot One');
    await expectProtected(await send('POST', `/payees/${p.payee}/merge?budget_id=${p.b}`, { target_id: p.payee2 }), 'Transfer : Prot One');
    expect(await payeeIdOf(row)).toBe(p.ordinary);
    expect((await pool!.query('SELECT deleted FROM payees WHERE id = ANY($1)', [[p.payee, p.ordinary]])).rows.every((r) => r.deleted === false)).toBe(true);
  });

  test('delete and hide are refused; showing a payee is still allowed', async () => {
    const p = await protectedBudget();
    await expectProtected(await send('DELETE', `/payees/${p.payee}?budget_id=${p.b}`), 'Transfer : Prot One');
    await expectProtected(await send('PATCH', `/payees/${p.payee}/hidden?budget_id=${p.b}`, { hidden: true }), 'Transfer : Prot One');
    const row = (await pool!.query('SELECT deleted, hidden FROM payees WHERE id = $1', [p.payee])).rows[0];
    expect([row.deleted, row.hidden]).toEqual([false, false]);
    expect((await send('PATCH', `/payees/${p.payee}/hidden?budget_id=${p.b}`, { hidden: false })).status).toBe(204);
  });

  test('ordinary payees are still renamed, hidden and deleted as before', async () => {
    const p = await protectedBudget();
    expect((await send('PATCH', `/payees/${p.ordinary}/name?budget_id=${p.b}`, { name: 'Ordinary Renamed' })).status).toBe(204);
    expect((await send('PATCH', `/payees/${p.ordinary}/hidden?budget_id=${p.b}`, { hidden: true })).status).toBe(204);
    expect((await send('DELETE', `/payees/${p.ordinary}?budget_id=${p.b}`)).status).toBe(204);
  });

  test('a renaming rule on a transfer payee stays allowed and makes the matching text a transfer', async () => {
    const p = await protectedBudget();
    const set = await send('PUT', `/payees/${p.payee2}/rename-rule?budget_id=${p.b}`, { match_type: 'contains', condition: 'PIX SAVINGS' });
    expect(set.status).toBe(204);
    const t = await createTransfer(p.b, p.acc, 'PIX SAVINGS');
    expect(t.res.status, t.text).toBe(201);
    expect(t.body!.payee_id).toBe(p.payee2);
    expect(t.body!.transfer_account_id).toBe(p.acc2);
    const mirror = await pool!.query('SELECT account_id FROM transactions WHERE transfer_transaction_id = $1', [t.body!.id]);
    expect(mirror.rows[0].account_id).toBe(p.acc2);
  });
});

describe.skipIf(!dbReady)('listing: GET /payees names the account of a transfer payee, on request', () => {
  test('transfer payees are listed only with include_transfers=true, each with its account name', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'List Acct');
    await rawPayee(b, 'Plain Shop');

    const plain = (await (await send('GET', `/payees?budget_id=${b}`)).json()) as { name: string; transfer_account_id: string | null }[];
    expect(plain.map((p) => p.name)).toEqual(['Plain Shop']);

    const res = await send('GET', `/payees?budget_id=${b}&include_transfers=true`);
    expect(res.status).toBe(200);
    const all = (await res.json()) as { name: string; transfer_account_id: string | null; transfer_account_name?: string | null }[];
    expect(all.map((p) => p.name)).toEqual(['Plain Shop', 'Transfer : List Acct']);
    const transfer = all.find((p) => p.name === 'Transfer : List Acct')!;
    expect(transfer.transfer_account_id).toBe(a);
    expect(transfer.transfer_account_name).toBe('List Acct');
    expect(all.find((p) => p.name === 'Plain Shop')!.transfer_account_name ?? null).toBeNull();

    // The account name is the CURRENT one.
    await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'List Renamed' });
    const renamed = (await (await send('GET', `/payees?budget_id=${b}&include_transfers=true`)).json()) as { name: string; transfer_account_name?: string | null }[];
    expect(renamed.find((p) => p.transfer_account_name)).toMatchObject({ name: 'Transfer : List Renamed', transfer_account_name: 'List Renamed' });
  });
});

describe.skipIf(!dbReady)('resolution by id: payee text reaches the canonical payee or is refused', () => {
  test('text naming two accounts with no payee of that name is refused with transfer_payee_ambiguous, and nothing is written', async () => {
    const b = await newBudget();
    const from = await legacyAccount(b, 'Amb From');
    await legacyAccount(b, 'Amb Twin');
    await legacyAccount(b, 'Amb Twin');
    const res = await send('POST', '/transactions', { budget_id: b, txn: txnBody(from, 'Transfer : Amb Twin') });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('transfer_payee_ambiguous');
    expect((await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [b])).rows[0].n).toBe(0);
    expect((await pool!.query("SELECT count(*)::int AS n FROM payees WHERE budget_id = $1 AND name LIKE 'Transfer : Amb Twin%'", [b])).rows[0].n).toBe(0);
  });

  test('text naming one legacy account (no payee yet) creates that account\'s payee and transfers to it', async () => {
    const b = await newBudget();
    const from = await legacyAccount(b, 'Leg From');
    const to = await legacyAccount(b, 'Leg To');
    const t = await createTransfer(b, from, 'Transfer : Leg To');
    expect(t.res.status, t.text).toBe(201);
    expect(t.body!.transfer_account_id).toBe(to);
    expect(await expectOneTransferPayee(to, 'Transfer : Leg To')).toBe(t.body!.payee_id);
  });

  test('text for an account that does not exist stays an ordinary payee', async () => {
    const b = await newBudget();
    const from = await createAccount(b, 'Ghost From');
    const t = await createTransfer(b, from, 'Transfer : Nobody Here');
    expect(t.res.status).toBe(201);
    expect(t.body!.transfer_account_id ?? null).toBeNull();
    expect((await pool!.query('SELECT transfer_account_id FROM payees WHERE id = $1', [t.body!.payee_id])).rows[0].transfer_account_id).toBeNull();
  });

  test('editing a row to a transfer payee text resolves through the account too', async () => {
    const b = await newBudget();
    const from = await createAccount(b, 'Edit From');
    const to = await createAccount(b, 'Edit To');
    const plain = await send('POST', '/transactions', { budget_id: b, txn: txnBody(from, 'Corner Shop') });
    const id = ((await plain.json()) as { id: string }).id;
    const res = await send('PATCH', `/transactions/${id}`, { budget_id: b, patch: { payee: 'Transfer : Edit To' } });
    expect(res.status, await res.clone().text()).toBe(204);
    const row = (await pool!.query('SELECT payee_id, transfer_account_id FROM transactions WHERE id = $1', [id])).rows[0];
    expect(row.transfer_account_id).toBe(to);
    expect(row.payee_id).toBe(await accountPointer(to));
  });
});
