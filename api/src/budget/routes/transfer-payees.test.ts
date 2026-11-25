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
app.route('/repeat-rules', (await import('./repeat-rules')).default);

const budgets: string[] = [];

/** Capture console.warn (the collision / repair-needed lines). */
function spyOnWarn() {
  const original = console.warn;
  const lines: string[] = [];
  console.warn = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
  return { lines, restore: () => void (console.warn = original) };
}

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

/** The repair runs in one transaction (it uses savepoints), like the script does. */
async function repair(budgetId: string, apply: boolean) {
  const { withTransaction } = await import('../../core/db');
  const { repairTransferPayees } = await import('../domain/transfer-payee-repair');
  return withTransaction(pool!, (client) => repairTransferPayees(client, budgetId, { apply }));
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

    // A third account (the register's "from" side) transfers to each: the first by its payee id,
    // the second by the numbered payee name; the plain text goes to the newest account.
    const from = await createAccount(b, 'Same From');
    const toFirst = await send('POST', '/transactions', { budget_id: b, txn: { ...txnBody(from, ''), payee_id: firstPayee } });
    const first1 = (await toFirst.json()) as { payee_id: string; transfer_account_id: string };
    const toSecond = await createTransfer(b, from, 'Transfer : Same Name (2)');
    expect(first1.transfer_account_id).toBe(first);
    expect(first1.payee_id).toBe(firstPayee);
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

  test('renaming onto a name held by an ordinary payee touches that payee not at all; the transfer payee gets the numbered name', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'Fold Old');
    const payeeId = await expectOneTransferPayee(a, 'Transfer : Fold Old');
    const leftover = await rawPayee(b, 'Transfer : Fold Target', null, { rule: ['contains', 'PIX LEFTOVER'], hidden: true });
    await pool!.query("UPDATE payees SET categorization_mode = 'never' WHERE id = $1", [leftover]);
    await pool!.query("INSERT INTO payee_locations (budget_id, payee_id, latitude, longitude) VALUES ($1, $2, '1', '2')", [b, leftover]);
    const peer = await legacyAccount(b, 'Fold Peer');
    const row = await rawTxn(b, peer, leftover);
    const warn = spyOnWarn();

    const res = await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'Fold Target' });
    expect(res.status, await res.clone().text()).toBe(200);

    expect(await expectOneTransferPayee(a, 'Transfer : Fold Target (2)')).toBe(payeeId);
    const kept = (await pool!.query('SELECT name, hidden, deleted, rename_condition, categorization_mode, transfer_account_id FROM payees WHERE id = $1', [leftover])).rows[0];
    expect(kept).toEqual({ name: 'Transfer : Fold Target', hidden: true, deleted: false, rename_condition: 'PIX LEFTOVER', categorization_mode: 'never', transfer_account_id: null });
    expect((await pool!.query('SELECT 1 FROM payee_locations WHERE payee_id = $1', [leftover])).rowCount).toBe(1);
    expect(await payeeIdOf(row)).toBe(leftover);
    // The collision is logged for the repair, which folds the leftover in.
    expect(warn.lines.join('\n')).toContain(leftover);
    warn.restore();
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

  test('a fresh-start copy gives every account a payee, deletes and merges nothing, and reports the damage it copied', async () => {
    const b = await newBudget();
    const dup = await legacyAccount(b, 'Copy Dup');
    const lone = await legacyAccount(b, 'Copy Lone');
    void lone;
    const keep = await rawPayee(b, 'Transfer : Copy Dup', dup);
    await rawPayee(b, 'Transfer : Copy Dup Renamed', dup, { rule: ['contains', 'COPY-RULE'] });
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, dup]);
    const warn = spyOnWarn();

    const res = await send('POST', '/budgets/fresh-start', { budget_id: b });
    warn.restore();
    expect(res.status, await res.clone().text()).toBe(200);
    const created = ((await res.json()) as { created: { id: string } }).created.id;
    budgets.push(created);

    const accounts = (await pool!.query<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE budget_id = $1', [created])).rows;
    expect(accounts.map((a) => a.name).sort()).toEqual(['Copy Dup', 'Copy Lone']);
    const copiedDup = accounts.find((a) => a.name === 'Copy Dup')!;
    const copiedLone = accounts.find((a) => a.name === 'Copy Lone')!;
    await expectOneTransferPayee(copiedLone.id, 'Transfer : Copy Lone');
    // Nothing merged or deleted: both copies of the duplicate pair (and the rule) are there.
    expect((await linkedPayees(copiedDup.id)).map((p) => p.name).sort()).toEqual(['Transfer : Copy Dup', 'Transfer : Copy Dup Renamed']);
    expect((await pool!.query("SELECT 1 FROM payees WHERE budget_id = $1 AND rename_condition = 'COPY-RULE'", [created])).rowCount).toBe(1);
    // The report is not thrown away.
    const line = warn.lines.find((l) => l.includes('fresh start') && l.includes(created));
    expect(line).toContain('repair needed');
    expect(line).toContain(copiedDup.id);
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
    expect(report.dropped_rules).toEqual([
      { kind: 'rename_rule', account_id: d.one, payee_id: d.newPayee, payee_name: 'Transfer : Rep One', detail: 'contains "NEW-RULE"', kept_payee_id: d.oldPayee },
    ]);
    expect(report.rename_rules_moved).toBe(0);
    expect(report.pointers_fixed).toBe(2);
    expect(report.payees_renamed).toBe(1);
    expect(await snapshot(d.b)).toEqual(before);
  });

  test('apply leaves one canonical payee per account, re-points transactions and rules, removes the extras', async () => {
    const d = await damagedBudget();
    const planned = await repair(d.b, false);
    const applied = await repair(d.b, true);
    expect(applied.applied).toBe(true);
    // The report is the plan it executed. The half-linked rows are read where the run
    // stands: a payee-only row of a folded name-only payee only shows up once the payee is
    // linked, so that part is compared separately (a leg without any other side is
    // reported, not created, and the second run lists it again).
    expect({ ...applied, applied: false, half_linked: planned.half_linked }).toEqual(planned);
    expect(planned.half_linked.needs_mirror).toBe(3);
    expect(applied.half_linked.needs_mirror).toBe(4);
    expect(applied.half_linked.mirrors_created).toBe(0);

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
    const again = await repair(d.b, true);
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

    await repair(b, true);
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
  test('with two accounts of one name the plain text goes to the account that holds the plain payee name, "(2)" to the second; payee_id reaches either', async () => {
    const b = await newBudget();
    const from = await legacyAccount(b, 'Amb From');
    const older = await createAccount(b, 'Amb Twin');
    const newer = await createAccount(b, 'Amb Twin');
    const olderPayee = await expectOneTransferPayee(older, 'Transfer : Amb Twin');
    const newerPayee = await expectOneTransferPayee(newer, 'Transfer : Amb Twin (2)');

    const byText = await createTransfer(b, from, 'Transfer : Amb Twin');
    expect(byText.body!.transfer_account_id).toBe(older);
    expect(byText.body!.payee_id).toBe(olderPayee);
    const bySecond = await createTransfer(b, from, 'Transfer : Amb Twin (2)');
    expect(bySecond.body!.transfer_account_id).toBe(newer);
    expect(bySecond.body!.payee_id).toBe(newerPayee);

    const byId = await send('POST', '/transactions', { budget_id: b, txn: { ...txnBody(from, 'ignored text'), payee_id: olderPayee } });
    expect(byId.status, await byId.clone().text()).toBe(201);
    const row = (await byId.json()) as { id: string; payee_id: string; transfer_account_id: string };
    expect(row.transfer_account_id).toBe(older);
    expect(row.payee_id).toBe(olderPayee);
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
    expect(row.payee_id).toBe((await accountPointer(to))!);
  });
});

const balanceOf = async (accountId: string) =>
  (await pool!.query('SELECT cleared_balance::int AS c, uncleared_balance::int AS u FROM accounts WHERE id = $1', [accountId])).rows[0] as { c: number; u: number };
const txnRow = async (id: string) =>
  (await pool!.query<{ payee_id: string | null; transfer_transaction_id: string | null; transfer_account_id: string | null; memo: string | null }>(
    'SELECT payee_id, transfer_transaction_id, transfer_account_id, memo FROM transactions WHERE id = $1',
    [id],
  )).rows[0]!;
const liveRowsIn = async (accountId: string) =>
  (await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE account_id = $1 AND deleted = false', [accountId])).rows[0].n as number;

describe.skipIf(!dbReady)('edits: stale or legacy payee text never changes a row it cannot tell from "unchanged"', () => {
  test('the released client re-sends the OLD name of a renamed peer: the transfer, its mirror and both balances stay', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Stale Src');
    const dst = await createAccount(b, 'Stale Dst Old');
    const made = await createTransfer(b, src, 'Transfer : Stale Dst Old');
    await send('PATCH', `/accounts/${dst}`, { budget_id: b, name: 'Stale Dst New' });
    const before = { src: await balanceOf(src), dst: await balanceOf(dst), row: await txnRow(made.body!.id) };

    const res = await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee: 'Transfer : Stale Dst Old', memo: 'edited' } });
    expect(res.status, await res.clone().text()).toBe(204);

    const after = await txnRow(made.body!.id);
    expect(after.memo).toBe('edited');
    expect(after.payee_id).toBe(before.row.payee_id);
    expect(after.transfer_transaction_id).toBe(before.row.transfer_transaction_id);
    expect(after.transfer_account_id).toBe(dst);
    expect(await balanceOf(src)).toEqual(before.src);
    expect(await balanceOf(dst)).toEqual(before.dst);
    expect((await pool!.query('SELECT deleted FROM transactions WHERE id = $1', [before.row.transfer_transaction_id])).rows[0].deleted).toBe(false);
    expect((await pool!.query("SELECT 1 FROM payees WHERE budget_id = $1 AND name = 'Transfer : Stale Dst Old'", [b])).rowCount).toBe(0);
  });

  test('payee_id wins over stale text, even when a new account has taken the old name', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Id Src');
    const dst = await createAccount(b, 'Id Old');
    const made = await createTransfer(b, src, 'Transfer : Id Old');
    await send('PATCH', `/accounts/${dst}`, { budget_id: b, name: 'Id New' });
    const newcomer = await createAccount(b, 'Id Old');
    const dstPayee = await accountPointer(dst);

    const res = await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee: 'Transfer : Id Old', payee_id: dstPayee, memo: 'edited' } });
    expect(res.status, await res.clone().text()).toBe(204);
    expect((await txnRow(made.body!.id)).transfer_account_id).toBe(dst);
    expect(await liveRowsIn(newcomer)).toBe(0);
  });

  test('text that names a DIFFERENT live account moves the transfer; payee_id does the same; null clears the payee', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Move Src');
    const one = await createAccount(b, 'Move One');
    const two = await createAccount(b, 'Move Two');
    const made = await createTransfer(b, src, 'Transfer : Move One');
    expect(await liveRowsIn(one)).toBe(1);

    expect((await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee: 'Transfer : Move Two' } })).status).toBe(204);
    expect((await txnRow(made.body!.id)).transfer_account_id).toBe(two);
    expect([await liveRowsIn(one), await liveRowsIn(two)]).toEqual([0, 1]);

    expect((await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee_id: await accountPointer(one) } })).status).toBe(204);
    expect((await txnRow(made.body!.id)).transfer_account_id).toBe(one);

    expect((await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee_id: null } })).status).toBe(204);
    const cleared = await txnRow(made.body!.id);
    expect([cleared.payee_id, cleared.transfer_account_id, cleared.transfer_transaction_id]).toEqual([null, null, null]);
    expect([await liveRowsIn(one), await liveRowsIn(two)]).toEqual([0, 0]);
  });

  test('a legacy row on a name-only "Transfer : X" payee keeps its payee on a memo edit: no mirror appears in X', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Legacy Src');
    const x = await createAccount(b, 'Legacy Old Name');
    // Old code renamed accounts without renaming their payee: X's payee keeps the old name, X is called "Legacy X".
    await pool!.query("UPDATE accounts SET name = 'Legacy X' WHERE id = $1", [x]);
    const nameOnly = await rawPayee(b, 'Transfer : Legacy X');
    const row = await rawTxn(b, src, nameOnly);
    const before = await balanceOf(x);

    const res = await send('PATCH', `/transactions/${row}`, { budget_id: b, patch: { payee: 'Transfer : Legacy X', memo: 'edited' } });
    expect(res.status, await res.clone().text()).toBe(204);

    const after = await txnRow(row);
    expect([after.payee_id, after.transfer_transaction_id, after.transfer_account_id]).toEqual([nameOnly, null, null]);
    expect(await balanceOf(x)).toEqual(before);
    expect(await liveRowsIn(x)).toBe(0);
  });

  test('typing a transfer payee on an ordinary row still makes it a transfer', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Typed Src');
    const dst = await createAccount(b, 'Typed Dst');
    const row = await rawTxn(b, src, await rawPayee(b, 'Corner Shop'));
    expect((await send('PATCH', `/transactions/${row}`, { budget_id: b, patch: { payee: 'Transfer : Typed Dst' } })).status).toBe(204);
    expect((await txnRow(row)).transfer_account_id).toBe(dst);
    expect(await liveRowsIn(dst)).toBe(1);
  });

  test('a payee_id from another budget is refused', async () => {
    const b = await newBudget();
    const other = await newBudget();
    const src = await createAccount(b, 'Foreign Src');
    const foreign = await rawPayee(other, 'Foreign Payee');
    const res = await send('POST', '/transactions', { budget_id: b, txn: { ...txnBody(src, ''), payee_id: foreign } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe('payee_not_in_budget');
  });
});

describe.skipIf(!dbReady)('ordinary requests never repair: they use bad data as it is', () => {
  const payeeState = async (b: string) =>
    (await pool!.query('SELECT id, name, hidden, deleted, transfer_account_id FROM payees WHERE budget_id = $1 ORDER BY id', [b])).rows;
  const pointers = async (b: string) =>
    (await pool!.query('SELECT id, transfer_payee_id FROM accounts WHERE budget_id = $1 ORDER BY id', [b])).rows;

  test('a transfer to an account with a hidden payee leaves it hidden', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Hid Src');
    const dst = await createAccount(b, 'Hid Dst');
    const payee = await accountPointer(dst);
    await pool!.query('UPDATE payees SET hidden = true WHERE id = $1', [payee]);
    const before = await payeeState(b);
    const t = await createTransfer(b, src, 'Transfer : Hid Dst');
    expect(t.body!.payee_id).toBe(payee!);
    expect(await payeeState(b)).toEqual(before);
  });

  test('a retired payee is not un-deleted, a disagreeing pointer is not re-pointed, no numbered payee is inserted', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Bad Src');
    const retired = await legacyAccount(b, 'Bad Retired');
    const retiredPayee = await rawPayee(b, 'Transfer : Bad Retired', retired);
    await pool!.query('UPDATE payees SET deleted = true WHERE id = $1', [retiredPayee]);
    const stolen = await legacyAccount(b, 'Bad Stolen');
    const other = await legacyAccount(b, 'Bad Other');
    const otherPayee = await rawPayee(b, 'Transfer : Bad Other', other);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [otherPayee, stolen]);
    const before = { payees: await payeeState(b), accounts: await pointers(b) };

    await createTransfer(b, src, 'Transfer : Bad Retired');
    await createTransfer(b, src, 'Transfer : Bad Stolen');

    // Nothing was repaired: every pointer and every payee row is as it was, a retired payee
    // stays retired, and the other account's payee is not re-pointed or handed to the mirror.
    // The only write is the missing payee of the account whose pointer is wrong, created
    // unlinked from the pointer (like a missing payee), which is left to the repair.
    expect(await pointers(b)).toEqual(before.accounts);
    const after = await payeeState(b);
    for (const row of before.payees) expect(after).toContainEqual(row);
    const added = after.filter((p) => !before.payees.some((q) => q.id === p.id));
    expect(added).toEqual([expect.objectContaining({ name: 'Transfer : Bad Stolen', transfer_account_id: stolen, deleted: false })]);
    const stolenMirror = (await pool!.query('SELECT payee_id FROM transactions WHERE account_id = $1', [stolen])).rows[0];
    expect(stolenMirror.payee_id).not.toBe(otherPayee);
  });

  test('an account whose payee is missing gets one created, and nothing else changes', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Miss Src');
    const lone = await legacyAccount(b, 'Miss Lone');
    const before = await payeeState(b);
    await createTransfer(b, src, 'Transfer : Miss Lone');
    const after = await payeeState(b);
    expect(after).toHaveLength(before.length + 1);
    await expectOneTransferPayee(lone, 'Transfer : Miss Lone');
    for (const row of before) expect(after).toContainEqual(row);
  });

  test('deleting an account frees its payee name for a new account of the same name', async () => {
    const b = await newBudget();
    const gone = await createAccount(b, 'Reborn');
    expect((await send('PATCH', `/accounts/${gone}`, { budget_id: b, closed: true })).status).toBe(200);
    const del = await send('DELETE', `/accounts/${gone}?budget_id=${b}`);
    expect(del.status, await del.clone().text()).toBe(204);
    const again = await createAccount(b, 'Reborn');
    await expectOneTransferPayee(again, 'Transfer : Reborn');
  });
});

describe.skipIf(!dbReady)('the same text resolution on import, bank sync and repeat rules', () => {
  test('two accounts of one name: statement text goes by the exact payee name, a renaming rule to the payee it belongs to', async () => {
    const b = await newBudget();
    const target = await createAccount(b, 'Imp Target');
    const older = await createAccount(b, 'Imp Twin');
    const newer = await createAccount(b, 'Imp Twin');
    const olderPayee = await expectOneTransferPayee(older, 'Transfer : Imp Twin');
    const newerPayee = await expectOneTransferPayee(newer, 'Transfer : Imp Twin (2)');
    // A rule on the OLDER account's payee: its replacement is that payee's own name.
    expect((await send('PUT', `/payees/${olderPayee}/rename-rule?budget_id=${b}`, { match_type: 'is', condition: 'PIX IMP OLDER' })).status).toBe(204);

    const res = await send('POST', '/transactions/bulk', {
      budget_id: b,
      account_id: target,
      txns: [
        { date: '2026-03-01', payee: 'Transfer : Imp Twin', category_id: null, memo: null, outflow: 500, inflow: 0 },
        { date: '2026-03-02', payee: 'PIX IMP OLDER', category_id: null, memo: null, outflow: 700, inflow: 0 },
        { date: '2026-03-03', payee: 'Transfer : Imp Twin (2)', category_id: null, memo: null, outflow: 900, inflow: 0 },
      ],
    });
    expect(res.status, await res.clone().text()).toBe(201);
    // The text is resolved to the right account, but an import never stores the transfer payee
    // without a transfer behind it: the rows stay ordinary and carry the account as a hint.
    const rows = (await pool!.query<{ payee_id: string | null; account_id: string | null; name: string | null }>(
      `SELECT t.payee_id, h.account_id, p.name FROM transactions t
       LEFT JOIN transfer_hints h ON h.transaction_id = t.id LEFT JOIN payees p ON p.id = t.payee_id
       WHERE t.account_id = $1 ORDER BY t.date`,
      [target],
    )).rows;
    expect(rows.map((r) => r.account_id)).toEqual([older, older, newer]);
    expect(rows.map((r) => r.payee_id)).not.toContain(olderPayee);
    expect(rows.map((r) => r.payee_id)).not.toContain(newerPayee);
    expect(rows.map((r) => r.name)).toEqual([null, 'PIX IMP OLDER', null]);
    // No ordinary payee called "Transfer : Imp Twin" was created next to the system ones.
    expect((await pool!.query("SELECT count(*)::int AS n FROM payees WHERE budget_id = $1 AND name LIKE 'Transfer : Imp Twin%'", [b])).rows[0].n).toBe(2);
  });

  test('the bank-sync payee resolver maps the same text to the same payee, legacy accounts included', async () => {
    const b = await newBudget();
    const dst = await createAccount(b, 'Sync Dst');
    const legacy = await legacyAccount(b, 'Sync Legacy');
    const { createImportPayeeResolver } = await import('../ledger');
    const { withTransaction } = await import('../../core/db');
    await withTransaction(pool!, async (client) => {
      const resolver = createImportPayeeResolver(client, b);
      // The text names the account (the same account as in the register), but the stored payee is never its transfer payee.
      const toDst = await resolver.resolve('Transfer : Sync Dst');
      expect(toDst).toMatchObject({ id: null, name: '', importName: 'Transfer : Sync Dst', transferAccountId: dst });
      expect(toDst.legacyName).toBe('Transfer : Sync Dst');
      const toLegacy = await resolver.resolve('Transfer : Sync Legacy');
      expect(toLegacy.transferAccountId).toBe(legacy);
      expect(toLegacy.id).toBeNull();
      // Resolving made sure the legacy account has its transfer payee.
      const pointer = (await client.query<{ transfer_payee_id: string | null }>('SELECT transfer_payee_id FROM accounts WHERE id = $1', [legacy])).rows[0]!.transfer_payee_id;
      expect(pointer).not.toBeNull();
      const shop = await resolver.resolve('Corner Shop');
      expect(shop.id).not.toBeNull();
      expect(shop.transferAccountId).toBeNull();
    });
  });

  test('a repeat rule typed with a transfer text uses the account payee', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Rep Rule Src');
    const dst = await createAccount(b, 'Rep Rule Dst');
    const res = await send('POST', '/repeat-rules', {
      budget_id: b,
      account_id: src,
      payee: 'Transfer : Rep Rule Dst',
      category_id: null,
      memo: 'm',
      outflow: 1000,
      inflow: 0,
      frequency: 'monthly',
      next_due_date: '2099-01-01',
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const rule = (await res.json()) as { id: string };
    expect((await pool!.query('SELECT payee_id FROM txn_repeat_rules WHERE id = $1', [rule.id])).rows[0].payee_id).toBe((await accountPointer(dst))!);
  });
});

describe.skipIf(!dbReady)('repair: every reference moves, only within its own budget, and dropped rules are named', () => {
  test('splits, scheduled rows, repeat rules, link records and transactions of the duplicate all move to the kept payee', async () => {
    const b = await newBudget();
    const peer = await createAccount(b, 'Refs Peer');
    const a = await legacyAccount(b, 'Refs Acct');
    const keep = await rawPayee(b, 'Transfer : Refs Acct', a);
    const extra = await rawPayee(b, 'Transfer : Refs Acct Old', a);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, a]);
    const txn = await rawTxn(b, peer, extra);
    const sub = (await pool!.query<{ id: string }>(
      'INSERT INTO subtransactions (budget_id, transaction_id, amount, payee_id) VALUES ($1, $2, -100, $3) RETURNING id',
      [b, txn, extra],
    )).rows[0]!.id;
    const sched = (await pool!.query<{ id: string }>(
      `INSERT INTO scheduled_transactions (budget_id, account_id, date_first, date_next, frequency, amount, payee_id)
       VALUES ($1, $2, '2030-01-01', '2030-01-01', 'monthly', -5, $3) RETURNING id`,
      [b, peer, extra],
    )).rows[0]!.id;
    const schedSub = (await pool!.query<{ id: string }>(
      'INSERT INTO scheduled_subtransactions (budget_id, scheduled_transaction_id, amount, payee_id) VALUES ($1, $2, -5, $3) RETURNING id',
      [b, sched, extra],
    )).rows[0]!.id;
    const rule = (await pool!.query<{ id: string }>(
      `INSERT INTO txn_repeat_rules (budget_id, account_id, payee_id, amount, frequency, next_due_date)
       VALUES ($1, $2, $3, -5, 'monthly', '2030-01-01') RETURNING id`,
      [b, peer, extra],
    )).rows[0]!.id;
    await pool!.query(`INSERT INTO transfer_links (transaction_id, budget_id, peer_transaction_id, method, prev_payee_id) VALUES ($1, $2, $1, 'auto', $3)`, [txn, b, extra]);

    const report = await repair(b, true);
    expect(report.payees_removed).toBe(1);
    expect(await payeeExists(extra)).toBe(false);
    const ref = async (sql: string, id: string) => (await pool!.query<{ p: string | null }>(sql, [id])).rows[0]!.p;
    expect(await ref('SELECT payee_id AS p FROM transactions WHERE id = $1', txn)).toBe(keep);
    expect(await ref('SELECT payee_id AS p FROM subtransactions WHERE id = $1', sub)).toBe(keep);
    expect(await ref('SELECT payee_id AS p FROM scheduled_transactions WHERE id = $1', sched)).toBe(keep);
    expect(await ref('SELECT payee_id AS p FROM scheduled_subtransactions WHERE id = $1', schedSub)).toBe(keep);
    expect(await ref('SELECT payee_id AS p FROM txn_repeat_rules WHERE id = $1', rule)).toBe(keep);
    expect(await ref('SELECT prev_payee_id AS p FROM transfer_links WHERE transaction_id = $1', txn)).toBe(keep);
  });

  test('a duplicate that rows of ANOTHER budget reference is not deleted: it stays unlinked, nothing in the other budget changes, the report lists it', async () => {
    const b = await newBudget();
    const other = await newBudget();
    const peer = await createAccount(b, 'Iso Peer');
    const otherAccount = await createAccount(other, 'Iso Other');
    const a = await legacyAccount(b, 'Iso Acct');
    const keep = await rawPayee(b, 'Transfer : Iso Acct', a);
    const extra = await rawPayee(b, 'Transfer : Iso Acct Old', a);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, a]);
    const mine = await rawTxn(b, peer, extra);
    const foreign = await rawTxn(other, otherAccount, extra);
    const foreignRule = (await pool!.query<{ id: string }>(
      `INSERT INTO txn_repeat_rules (budget_id, account_id, payee_id, amount, frequency, next_due_date)
       VALUES ($1, $2, $3, -5, 'monthly', '2030-01-01') RETURNING id`,
      [other, otherAccount, extra],
    )).rows[0]!.id;
    await pool!.query(`INSERT INTO transfer_links (transaction_id, budget_id, peer_transaction_id, method, prev_payee_id) VALUES ($1, $2, $1, 'auto', $3)`, [foreign, other, extra]);
    const otherBefore = {
      txn: await txnRow(foreign),
      rule: (await pool!.query('SELECT payee_id FROM txn_repeat_rules WHERE id = $1', [foreignRule])).rows[0].payee_id,
      link: (await pool!.query('SELECT prev_payee_id FROM transfer_links WHERE transaction_id = $1', [foreign])).rows[0].prev_payee_id,
    };

    const planned = await repair(b, false);
    expect(planned.kept_payees).toEqual([
      { payee_id: extra, payee_name: 'Transfer : Iso Acct Old', account_id: a, state: 'will_unlink', reason: 'referenced from another budget' },
    ]);
    expect(planned.payees_removed).toBe(0);
    const applied = await repair(b, true);
    expect(applied.kept_payees).toEqual(planned.kept_payees);

    // This budget: the row moved, the account has one linked payee, the duplicate is kept but unlinked.
    expect(await payeeIdOf(mine)).toBe(keep);
    await expectOneTransferPayee(a, 'Transfer : Iso Acct');
    const keptRow = (await pool!.query('SELECT deleted, hidden, transfer_account_id FROM payees WHERE id = $1', [extra])).rows[0];
    expect(keptRow).toEqual({ deleted: false, hidden: false, transfer_account_id: null });
    // The other budget: nothing changed, nothing dangling.
    expect(await txnRow(foreign)).toEqual(otherBefore.txn);
    expect((await pool!.query('SELECT payee_id FROM txn_repeat_rules WHERE id = $1', [foreignRule])).rows[0].payee_id).toBe(otherBefore.rule);
    expect((await pool!.query('SELECT prev_payee_id FROM transfer_links WHERE transaction_id = $1', [foreign])).rows[0].prev_payee_id).toBe(otherBefore.link);
    expect(await payeeExists(extra)).toBe(true);
    // Idempotent: nothing left to do (the kept payee stays listed for the owner).
    expect((await repair(b, true)).actions).toEqual([]);
  });

  test('the report names every rule it drops, renaming and "treat as transfer"', async () => {
    const b = await newBudget();
    const a = await legacyAccount(b, 'Drop Acct');
    const keep = await rawPayee(b, 'Transfer : Drop Acct', a, { rule: ['contains', 'KEEP-RULE'] });
    const extra = await rawPayee(b, 'Transfer : Drop Acct Old', a, { rule: ['is', 'LOST-RULE'] });
    await pool!.query("UPDATE payees SET transfer_rule = 'auto' WHERE id = $1", [keep]);
    await pool!.query("UPDATE payees SET transfer_rule = 'never' WHERE id = $1", [extra]);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, a]);

    const report = await repair(b, false);
    expect(report.dropped_rules).toEqual([
      { kind: 'rename_rule', account_id: a, payee_id: extra, payee_name: 'Transfer : Drop Acct Old', detail: 'is "LOST-RULE"', kept_payee_id: keep },
      { kind: 'transfer_rule', account_id: a, payee_id: extra, payee_name: 'Transfer : Drop Acct Old', detail: 'never', kept_payee_id: keep },
    ]);
    expect(report.rename_rules_dropped).toBe(1);
  });

  test('a rename racing a concurrent insert of the same name takes the next name instead of failing', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'Race Old');
    const payee = await accountPointer(a);
    await pool!.query("UPDATE accounts SET name = 'Race New' WHERE id = $1", [a]);
    const { renameTransferPayee } = await import('../domain/transfer-payees');
    const { withTransaction } = await import('../../core/db');
    let raced = false;
    const result = await withTransaction(pool!, async (client) => {
      const racing = {
        query: async (text: unknown, values?: unknown) => {
          // Between the name check and the UPDATE, another request takes the name.
          if (!raced && typeof text === 'string' && text.startsWith('UPDATE payees SET name')) {
            raced = true;
            await client.query("INSERT INTO payees (budget_id, name) VALUES ($1, 'Transfer : Race New')", [b]);
          }
          return (client.query as (t: unknown, v?: unknown) => Promise<unknown>)(text, values);
        },
      };
      return renameTransferPayee(racing as never, b, a);
    });
    expect(raced).toBe(true);
    expect(result.payee_id).toBe(payee!);
    expect(result.name).toBe('Transfer : Race New (2)');
    await expectOneTransferPayee(a, 'Transfer : Race New (2)');
  });
});

describe.skipIf(!dbReady)('former names: a stale text on an edit of a transfer never moves it, even when a new account holds the old name', () => {
  test('S2: peer renamed on another device, a NEW account takes the old name, the stale memo edit keeps the mirror where it was', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'S2 Src');
    const dst = await createAccount(b, 'S2 Old');
    const made = await createTransfer(b, src, 'Transfer : S2 Old');
    await send('PATCH', `/accounts/${dst}`, { budget_id: b, name: 'S2 New' });
    const newcomer = await createAccount(b, 'S2 Old');
    const before = { src: await balanceOf(src), dst: await balanceOf(dst), newcomer: await balanceOf(newcomer) };

    const res = await send('PATCH', `/transactions/${made.body!.id}`, { budget_id: b, patch: { payee: 'Transfer : S2 Old', memo: 'edited' } });
    expect(res.status, await res.clone().text()).toBe(204);

    const after = await txnRow(made.body!.id);
    expect(after.memo).toBe('edited');
    expect(after.transfer_account_id).toBe(dst);
    expect(after.payee_id).toBe(made.body!.payee_id);
    expect(await liveRowsIn(newcomer)).toBe(0);
    expect(await balanceOf(src)).toEqual(before.src);
    expect(await balanceOf(dst)).toEqual(before.dst);
    expect(await balanceOf(newcomer)).toEqual(before.newcomer);
  });

  test('on CREATE the same text still means the account that holds the name now', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'S2c Src');
    const dst = await createAccount(b, 'S2c Old');
    await send('PATCH', `/accounts/${dst}`, { budget_id: b, name: 'S2c New' });
    const newcomer = await createAccount(b, 'S2c Old');
    const t = await createTransfer(b, src, 'Transfer : S2c Old');
    expect(t.body!.transfer_account_id).toBe(newcomer);
  });

  test('every former name is remembered, and recording is written by the rename in the same transaction', async () => {
    const b = await newBudget();
    const a = await createAccount(b, 'FN One');
    const payee = (await accountPointer(a))!;
    await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'FN Two' });
    await send('PATCH', `/accounts/${a}`, { budget_id: b, name: 'FN Three' });
    const names = (await pool!.query<{ name: string }>('SELECT name FROM transfer_payee_former_names WHERE payee_id = $1 ORDER BY name', [payee])).rows.map((r) => r.name);
    expect(names).toEqual(['Transfer : FN One', 'Transfer : FN Two']);
  });
});

describe.skipIf(!dbReady)('one resolution order on create and edit: exact linked payee name first, then the account name', () => {
  test('D1: duplicating a transfer to the OLDER of two same-named accounts lands on the older one', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'D1 Src');
    const older = await createAccount(b, 'D1 X');
    const newer = await createAccount(b, 'D1 X');
    void newer;
    const olderPayee = (await accountPointer(older))!;
    const original = await send('POST', '/transactions', { budget_id: b, txn: { ...txnBody(src, ''), payee_id: olderPayee } });
    const orig = (await original.json()) as { id: string };
    const storedName = (await pool!.query('SELECT p.name FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE t.id = $1', [orig.id])).rows[0].name;
    // Duplicate / Make Repeat re-send the stored payee text as a new row.
    const dup = await createTransfer(b, src, storedName);
    expect(dup.body!.transfer_account_id).toBe(older);
    expect(dup.body!.payee_id).toBe(olderPayee);
  });

  test('D2: "Transfer : A (2)" is the second account named A, not a literal account called "A (2)"', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'D2 Src');
    await createAccount(b, 'D2 A');
    const second = await createAccount(b, 'D2 A');
    await createAccount(b, 'D2 A (2)');
    const t = await createTransfer(b, src, 'Transfer : D2 A (2)');
    expect(t.body!.transfer_account_id).toBe(second);
  });

  test('R1: a renaming rule whose target is an ORDINARY payee named "Transfer : X" keeps producing it, even after an account is renamed into that name', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'R1 Src');
    const x = await createAccount(b, 'R1 Old');
    const ordinary = await rawPayee(b, 'Transfer : R1 X', null, { rule: ['is', 'PIXR1'] });
    await send('PATCH', `/accounts/${x}`, { budget_id: b, name: 'R1 X' });
    const before = await balanceOf(x);

    const t = await createTransfer(b, src, 'PIXR1');
    expect(t.res.status, t.text).toBe(201);
    expect(t.body!.payee_id).toBe(ordinary);
    expect(t.body!.transfer_account_id ?? null).toBeNull();
    expect(await liveRowsIn(x)).toBe(0);
    expect(await balanceOf(x)).toEqual(before);

    // Import and the sync resolver agree.
    const bulk = await send('POST', '/transactions/bulk', {
      budget_id: b,
      account_id: src,
      txns: [{ date: '2026-03-01', payee: 'PIXR1', category_id: null, memo: null, outflow: 500, inflow: 0 }],
    });
    expect(bulk.status).toBe(201);
    const { createImportPayeeResolver } = await import('../ledger');
    const { withTransaction } = await import('../../core/db');
    await withTransaction(pool!, async (client) => {
      expect((await createImportPayeeResolver(client, b).resolve('PIXR1')).id).toBe(ordinary);
    });
    expect(await liveRowsIn(x)).toBe(0);
  });
});

describe.skipIf(!dbReady)('payee_id on create: validation', () => {
  test('the account\'s own payee is 400, a closed account\'s payee is 409, a retired payee is 400', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Val Src');
    const closed = await createAccount(b, 'Val Closed');
    const own = (await accountPointer(src))!;
    const closedPayee = (await accountPointer(closed))!;
    expect((await send('PATCH', `/accounts/${closed}`, { budget_id: b, closed: true })).status).toBe(200);
    const retired = await rawPayee(b, 'Retired Shop');
    await pool!.query('UPDATE payees SET deleted = true WHERE id = $1', [retired]);

    const make = (payee_id: string) => send('POST', '/transactions', { budget_id: b, txn: { ...txnBody(src, ''), payee_id } });
    const toSelf = await make(own);
    expect(toSelf.status).toBe(400);
    expect(((await toSelf.json()) as { code: string }).code).toBe('cannot_transfer_to_same_account');
    const toClosed = await make(closedPayee);
    expect(toClosed.status).toBe(409);
    expect(((await toClosed.json()) as { code: string }).code).toBe('account_closed');
    const toRetired = await make(retired);
    expect(toRetired.status).toBe(400);
    expect(((await toRetired.json()) as { code: string }).code).toBe('payee_not_in_budget');
    expect((await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE account_id = $1 AND deleted = false', [src])).rows[0].n).toBe(0);
  });
});

describe.skipIf(!dbReady)('carry-overs of the payee lifecycle review (budget-nq2f)', () => {
  const former = async (payeeId: string) =>
    (await pool!.query<{ name: string }>('SELECT name FROM transfer_payee_former_names WHERE payee_id = $1 ORDER BY name', [payeeId])).rows.map((r) => r.name);

  test('the repair records the folded payee\'s name and former names on the kept payee, so a stale edit text cannot move a mirror', async () => {
    const b = await newBudget();
    const peer = await createAccount(b, 'Rec Peer');
    const a = await legacyAccount(b, 'Rec Acct');
    const keep = await rawPayee(b, 'Transfer : Rec Acct', a);
    const extra = await rawPayee(b, 'Transfer : Rec Acct Old', a);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, a]);
    await pool!.query('INSERT INTO transfer_payee_former_names (payee_id, budget_id, name) VALUES ($1, $2, $3)', [extra, b, 'Transfer : Rec Older']);

    await repair(b, true);
    expect(await former(keep)).toEqual(['Transfer : Rec Acct Old', 'Transfer : Rec Older']);

    // A transfer row of the kept payee; then an account takes the folded name. The released
    // client still sends the old text on an edit: it must not move the mirror to the new account.
    const t = await createTransfer(b, peer, 'Transfer : Rec Acct');
    expect(t.res.status, t.text).toBe(201);
    const newcomer = await createAccount(b, 'Rec Acct Old');
    const legBefore = await txnRow(t.body!.id);
    const res = await send('PATCH', `/transactions/${t.body!.id}`, { budget_id: b, patch: { payee: 'Transfer : Rec Acct Old' } });
    expect(res.status, await res.clone().text()).toBe(204);
    const legAfter = await txnRow(t.body!.id);
    expect(legAfter).toEqual(legBefore);
    expect(legAfter.transfer_account_id).toBe(a);
    expect((await pool!.query('SELECT 1 FROM transactions WHERE account_id = $1 AND NOT deleted', [newcomer])).rowCount).toBe(0);
  });

  test('a transfer row edited to rule text that yields an ORDINARY "Transfer : X" payee stops being a transfer', async () => {
    const b = await newBudget();
    const src = await createAccount(b, 'Rule Src');
    await createAccount(b, 'Rule Dst');
    const plain = await rawPayee(b, 'Transfer : Rule Plain', null, { rule: ['is', 'ZED PIX'] });
    const t = await createTransfer(b, src, 'Transfer : Rule Dst');
    const mirrorId = (await txnRow(t.body!.id)).transfer_transaction_id!;
    const res = await send('PATCH', `/transactions/${t.body!.id}`, { budget_id: b, patch: { payee: 'ZED PIX' } });
    expect(res.status, await res.clone().text()).toBe(204);
    const row = await txnRow(t.body!.id);
    expect(row.payee_id).toBe(plain);
    expect([row.transfer_account_id, row.transfer_transaction_id]).toEqual([null, null]);
    expect((await pool!.query('SELECT deleted FROM transactions WHERE id = $1', [mirrorId])).rows[0].deleted).toBe(true);
  });

  test('a duplicate kept unlinked for another budget does not keep its "treat as transfer" rule: moved when the kept payee has none, else reported', async () => {
    for (const keptHasRule of [false, true]) {
      const b = await newBudget();
      const other = await newBudget();
      const peer = await createAccount(b, 'Rule Keep Peer');
      const otherAccount = await createAccount(other, 'Rule Keep Other');
      const a = await legacyAccount(b, 'Rule Keep Acct');
      const keep = await rawPayee(b, 'Transfer : Rule Keep Acct', a);
      const extra = await rawPayee(b, 'Transfer : Rule Keep Acct Old', a);
      await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [keep, a]);
      await rawTxn(b, peer, extra);
      await rawTxn(other, otherAccount, extra);
      await pool!.query("UPDATE payees SET transfer_rule = 'auto' WHERE id = $1", [extra]);
      if (keptHasRule) await pool!.query("UPDATE payees SET transfer_rule = 'never' WHERE id = $1", [keep]);

      const applied = await repair(b, true);
      expect(applied.kept_payees).toHaveLength(1);
      const rule = async (id: string) => (await pool!.query('SELECT transfer_rule FROM payees WHERE id = $1', [id])).rows[0].transfer_rule;
      expect(await rule(extra)).toBeNull(); // the unlinked leftover no longer treats anything as a transfer
      expect(await rule(keep)).toBe(keptHasRule ? 'never' : 'auto');
      expect(applied.dropped_rules.filter((d) => d.kind === 'transfer_rule').map((d) => d.payee_id)).toEqual(keptHasRule ? [extra] : []);
    }
  });

  test('an account whose pointer names another account\'s payee never hands it to a mirror', async () => {
    const b = await newBudget();
    const dst = await createAccount(b, 'Ptr Dst');
    const src = await legacyAccount(b, 'Ptr Src');
    const other = await legacyAccount(b, 'Ptr Other');
    const otherPayee = await rawPayee(b, 'Transfer : Ptr Other', other);
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [otherPayee, src]);
    const t = await createTransfer(b, src, 'Transfer : Ptr Dst');
    expect(t.res.status, t.text).toBe(201);
    const mirror = (await pool!.query('SELECT payee_id FROM transactions WHERE account_id = $1', [dst])).rows[0];
    expect(mirror.payee_id).not.toBe(otherPayee);
    expect((await pool!.query('SELECT transfer_account_id FROM payees WHERE id = $1', [mirror.payee_id])).rows[0].transfer_account_id).toBe(src);
    expect((await pool!.query('SELECT transfer_account_id FROM payees WHERE id = $1', [otherPayee])).rows[0].transfer_account_id).toBe(other);
  });

  test('deleting the older of two same-named accounts retires its own payee and leaves the newer one\'s alone, even with a wrong pointer', async () => {
    const b = await newBudget();
    const older = await createAccount(b, 'Del Twin');
    const newer = await createAccount(b, 'Del Twin');
    const olderPayee = await expectOneTransferPayee(older, 'Transfer : Del Twin');
    const newerPayee = await expectOneTransferPayee(newer, 'Transfer : Del Twin (2)');
    // Bad data: the older account's pointer names the newer account's payee.
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [newerPayee, older]);
    expect((await send('PATCH', `/accounts/${older}`, { budget_id: b, closed: true })).status).toBe(200);
    const del = await send('DELETE', `/accounts/${older}?budget_id=${b}`);
    expect(del.status, await del.clone().text()).toBe(204);
    const state = async (id: string) => (await pool!.query('SELECT deleted, transfer_account_id FROM payees WHERE id = $1', [id])).rows[0];
    expect(await state(newerPayee)).toEqual({ deleted: false, transfer_account_id: newer });
    expect((await state(olderPayee)).deleted).toBe(true);
    await expectOneTransferPayee(newer, 'Transfer : Del Twin (2)');
  });
});
