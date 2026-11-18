/**
 * Tests for server/budget/routes/accounts.ts — DELETE /accounts/:id (delete a closed
 * account and every transaction it ever held) and PATCH /accounts/:id unlink wire
 * (`link: { connectionId: null }` clears the bank link).
 *
 * Route exercised IN-PROCESS via app.request(). DB tests are gated on
 * Postgres reachability + migrated schema so `bun test` stays green without
 * a live DB. Fixtures self-clean: the test budget is deleted in afterAll and
 * cascades to accounts, payees, transactions, and repeat rules.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';

// Static imports cannot work here: ../db.ts throws at module load when
// DATABASE_URL is unset, and everything below (pool, migrate, the route
// modules) transitively requires it. Dynamic import inside try/catch keeps
// `bun test` green for DB-less environments, matching transactions.test.ts.
let pool: Pool | null = null;
let dbReady = false;

try {
  const db = await import('../../core/db');
  pool = db.pool;
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>(
    "select to_regclass('public.transactions')::text as t",
  );
  dbReady = schema.rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

// The route module is mounted under index.ts's app.onError(httpOnError) in
// production; mirror that here so HttpError statuses surface in-process.
const accountsApp = (await import('./accounts')).default;
const app = new (await import('hono')).Hono();
app.onError((await import('../../core/validate')).httpOnError);

// Phase 2 scoping (USER-05): mirror requireUser with a stubbed non-admin
// identity backed by a real users row (inserted in beforeAll) so the
// budgetAccess guard resolves ownership.
const testUserId = crypto.randomUUID();
const testUser: IdentityUser = {
  id: testUserId,
  email: 'account-delete-test@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};
app.use('*', (c, next) => {
  c.set('user', testUser);
  return next();
});
app.route('/accounts', accountsApp);

const budgetId = crypto.randomUUID();
const closedId = crypto.randomUUID();
const openId = crypto.randomUUID();
const peerId = crypto.randomUUID();
const transferPayeeId = crypto.randomUUID();
const linkedId = crypto.randomUUID();
const linkConnId = crypto.randomUUID();
const memberId = crypto.randomUUID();
const outsiderId = crypto.randomUUID();

const deleteAccount = (accountId: string) =>
  app.request(`/accounts/${accountId}?budget_id=${budgetId}`, { method: 'DELETE' });

beforeAll(async () => {
  if (!dbReady || !pool) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool.query(
    `INSERT INTO public.users (id, google_sub, email, role, status)
     VALUES ($1, null, $2, 'user', 'active')`,
    [testUserId, testUser.email],
  );
  await pool.query(
    'INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)',
    [budgetId, 'account-delete-test', testUserId],
  );
  // Person assignment fixtures: the owner is a member via the owner clause
  // (no budget_members row needed); `memberId` is a listed member and
  // `outsiderId` belongs to no budget.
  for (const [id, tag] of [[memberId, 'member'], [outsiderId, 'outsider']] as const) {
    await pool.query(
      `INSERT INTO public.users (id, google_sub, email, role, status)
       VALUES ($1, null, $2, 'user', 'active')`,
      [id, `account-person-${tag}@syscd.local`],
    );
  }
  await pool.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [budgetId, memberId]);
  // Closed account holding the money under test: +500000 milli cleared,
  // -200000 uncleared. Its transfer payee is wired the way migration 0004
  // backfills it (payee.transfer_account_id -> account, account
  // transfer_payee_id -> payee).
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, closed, cleared_balance, uncleared_balance)
     VALUES ($1, $2, 'Delete Me', 'checking', 'CASH', true, 500000, -200000)`,
    [closedId, budgetId],
  );
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, closed)
     VALUES ($1, $2, 'Still Open', 'checking', 'CASH', false)`,
    [openId, budgetId],
  );
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, closed)
     VALUES ($1, $2, 'Peer Acct', 'checking', 'CASH', false)`,
    [peerId, budgetId],
  );
  // A linked account mirroring a connected bank row: connection_id is a real
  // FK to connections, so the connection row is inserted first.
  await pool.query(
    `INSERT INTO connections (id, user_id, provider, external_id, status, institution)
     VALUES ($1, $2, 'pluggy', $3, 'connected', 'Itau')`,
    [linkConnId, testUserId, `unlink-test-${linkConnId}`],
  );
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, closed,
                           connection_id, external_account_id, institution)
     VALUES ($1, $2, 'Linked Bank', 'checking', 'CASH', false, $3, 'ext-1', 'Itau')`,
    [linkedId, budgetId, linkConnId],
  );
  await pool.query(
    `INSERT INTO payees (id, budget_id, name, transfer_account_id)
     VALUES ($1, $2, 'Transfer : Delete Me', $3)`,
    [transferPayeeId, budgetId, closedId],
  );
  await pool.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [
    transferPayeeId,
    closedId,
  ]);
  // The account's own rows: one cleared, one uncleared, one upcoming
  // (repeat-rule materialization — never balance-moving).
  await pool.query(
    `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved)
     VALUES
       ($1, $2, $3, '2025-03-01',  500000, null, null, '', 'cleared',   true),
       ($4, $2, $3, '2025-03-02', -200000, null, null, '', 'uncleared', true)`,
    [crypto.randomUUID(), budgetId, closedId, crypto.randomUUID()],
  );
  await pool.query(
    `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, upcoming)
     VALUES ($1, $2, $3, '2030-01-01', -750000, null, null, '', 'uncleared', true, true)`,
    [crypto.randomUUID(), budgetId, closedId],
  );
  // Peer transfer leg in the OTHER account — the money really left it, so it
  // must survive with its payee re-pointed.
  await pool.query(
    `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved)
     VALUES ($1, $2, $3, '2025-03-03', -250000, $4, null, '', 'cleared', true)`,
    [crypto.randomUUID(), budgetId, peerId, transferPayeeId],
  );
  // A live repeat rule pointed at the account would keep materializing rows
  // into a deleted account — the route retires it.
  await pool.query(
    `INSERT INTO txn_repeat_rules (budget_id, account_id, amount, frequency, next_due_date)
     VALUES ($1, $2, -750000, 'monthly', '2030-02-01')`,
    [budgetId, closedId],
  );
});

afterAll(async () => {
  if (!dbReady || !pool) return;
  await pool.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[testUserId, memberId, outsiderId]]);
});

describe('DELETE /accounts/:id', () => {
  test('exports a Hono app', () => {
    expect(accountsApp).toBeDefined();
    expect(typeof accountsApp.request).toBe('function');
  });

  test.skipIf(!dbReady)('rejects an open account with 409', async () => {
    const res = await deleteAccount(openId);
    expect(res.status).toBe(409);
    const open = await pool!.query('SELECT deleted, closed FROM accounts WHERE id = $1', [openId]);
    expect(open.rows[0].deleted).toBe(false);
  });

  test.skipIf(!dbReady)('404s an account outside the budget', async () => {
    const res = await app.request(
      `/accounts/${crypto.randomUUID()}?budget_id=${budgetId}`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(404);
  });

  test.skipIf(!dbReady)(
    'deletes the closed account: rows tombstoned, balances zeroed, peers re-pointed, rules retired',
    async () => {
      const res = await deleteAccount(closedId);
      expect(res.status).toBe(204);

      // Account: soft-deleted, balances zeroed.
      const acc = await pool!.query<{ deleted: boolean; cleared_balance: string; uncleared_balance: string }>(
        'SELECT deleted, cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
        [closedId],
      );
      expect(acc.rows[0].deleted).toBe(true);
      expect(Number(acc.rows[0].cleared_balance)).toBe(0);
      expect(Number(acc.rows[0].uncleared_balance)).toBe(0);

      // Every transaction it ever held — live and upcoming — is gone.
      const txns = await pool!.query<{ deleted: boolean; upcoming: boolean }>(
        'SELECT deleted, upcoming FROM transactions WHERE account_id = $1 ORDER BY date',
        [closedId],
      );
      expect(txns.rows.length).toBe(3);
      expect(txns.rows.every((t) => t.deleted)).toBe(true);

      // The peer transfer leg survives, re-pointed to a plain payee named
      // after the deleted account.
      const peer = await pool!.query<{ deleted: boolean; payee_id: string }>(
        'SELECT deleted, payee_id FROM transactions WHERE account_id = $1',
        [peerId],
      );
      expect(peer.rows[0].deleted).toBe(false);
      const plainPayee = await pool!.query<{ id: string; transfer_account_id: string | null }>(
        'SELECT id, transfer_account_id FROM payees WHERE budget_id = $1 AND name = $2 AND deleted = false',
        [budgetId, 'Delete Me'],
      );
      expect(plainPayee.rows.length).toBe(1);
      expect(peer.rows[0].payee_id).toBe(plainPayee.rows[0].id);
      expect(plainPayee.rows[0].transfer_account_id).toBe(null);

      // The transfer payee is retired; the repeat rule is tombstoned, not
      // hard-deleted (FK from tombstoned occurrences).
      const tp = await pool!.query<{ deleted: boolean; transfer_account_id: string | null }>(
        'SELECT deleted, transfer_account_id FROM payees WHERE id = $1',
        [transferPayeeId],
      );
      expect(tp.rows[0].deleted).toBe(true);
      expect(tp.rows[0].transfer_account_id).toBe(null);
      const rule = await pool!.query<{ deleted: boolean }>(
        'SELECT deleted FROM txn_repeat_rules WHERE account_id = $1',
        [closedId],
      );
      expect(rule.rows[0].deleted).toBe(true);

      // GET /accounts no longer lists it.
      const list = await app.request(`/accounts?budget_id=${budgetId}`);
      expect(list.status).toBe(200);
      const rows = (await list.json()) as { id: string }[];
      expect(rows.some((r) => r.id === closedId)).toBe(false);
      expect(rows.some((r) => r.id === openId)).toBe(true);
      expect(rows.some((r) => r.id === peerId)).toBe(true);
    },
  );

  test.skipIf(!dbReady)('404s on re-delete', async () => {
    const res = await deleteAccount(closedId);
    expect(res.status).toBe(404);
  });
});

describe('PATCH /accounts/:id — unlink wire', () => {
  test.skipIf(!dbReady)('link:{connectionId:null} clears connection_id, external_account_id, institution', async () => {
    // The exact body the client's linkAccount mutation sends to unlink
    // (modules/budget/data/api.ts): a link OBJECT with a null connectionId —
    // the route schema is z.object(...).optional(), so a bare `link: null`
    // body is rejected before this branch.
    const res = await app.request(`/accounts/${linkedId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, link: { connectionId: null } }),
    });
    expect(res.status).toBe(200);

    const acc = await pool!.query<{
      connection_id: string | null;
      external_account_id: string | null;
      institution: string | null;
    }>('SELECT connection_id, external_account_id, institution FROM accounts WHERE id = $1', [linkedId]);
    expect(acc.rows[0].connection_id).toBe(null);
    expect(acc.rows[0].external_account_id).toBe(null);
    expect(acc.rows[0].institution).toBe(null);
  });
});

describe('accounts.user_id (person)', () => {
  const send = (method: string, path: string, body: object) =>
    app.request(path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, ...body }),
    });
  type Row = { id: string; user_id: string | null };

  test.skipIf(!dbReady)('create defaults to Shared (null) and returns user_id', async () => {
    const res = await send('POST', '/accounts', { name: 'P Shared', type: 'checking' });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Row).user_id).toBeNull();
  });

  test.skipIf(!dbReady)('create with a member (and the owner) user_id is accepted', async () => {
    const res = await send('POST', '/accounts', { name: 'P Member', type: 'checking', user_id: memberId });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Row).user_id).toBe(memberId);
    const own = await send('POST', '/accounts', { name: 'P Owner', type: 'checking', user_id: testUserId });
    expect(own.status).toBe(201);
    expect(((await own.json()) as Row).user_id).toBe(testUserId);
  });

  test.skipIf(!dbReady)('create with a non-member user_id is 400 and writes nothing', async () => {
    const res = await send('POST', '/accounts', { name: 'P Outsider', type: 'checking', user_id: outsiderId });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('user_id is not a member of this budget');
    const n = await pool!.query("SELECT 1 FROM accounts WHERE budget_id = $1 AND name = 'P Outsider'", [budgetId]);
    expect(n.rowCount).toBe(0);
  });

  test.skipIf(!dbReady)('update sets, rejects non-members, and null clears', async () => {
    const created = (await (await send('POST', '/accounts', { name: 'P Edit', type: 'checking' })).json()) as Row;
    const set = await send('PATCH', `/accounts/${created.id}`, { user_id: memberId });
    expect(set.status).toBe(200);
    expect(((await set.json()) as Row).user_id).toBe(memberId);

    const bad = await send('PATCH', `/accounts/${created.id}`, { user_id: outsiderId });
    expect(bad.status).toBe(400);
    const kept = await pool!.query('SELECT user_id FROM accounts WHERE id = $1', [created.id]);
    expect(kept.rows[0].user_id).toBe(memberId);

    // Omitting user_id leaves it unchanged.
    const rename = await send('PATCH', `/accounts/${created.id}`, { name: 'P Edit 2' });
    expect(((await rename.json()) as Row).user_id).toBe(memberId);

    const cleared = await send('PATCH', `/accounts/${created.id}`, { user_id: null });
    expect(cleared.status).toBe(200);
    expect(((await cleared.json()) as Row).user_id).toBeNull();
  });

  test.skipIf(!dbReady)('GET returns user_id', async () => {
    const list = (await (await app.request(`/accounts?budget_id=${budgetId}`)).json()) as (Row & { name: string })[];
    expect(list.find((a) => a.name === 'P Member')?.user_id).toBe(memberId);
  });
});

describe('POST /accounts transfer payee', () => {
  test.skipIf(!dbReady)('a new account gets its linked "Transfer : <name>" payee', async () => {
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, name: 'Fresh Account', type: 'checking', user_id: null }),
    });
    expect(res.status).toBe(201);
    const acc = (await res.json()) as { id: string; transfer_payee_id: string | null };
    expect(acc.transfer_payee_id).not.toBeNull();
    const payee = await pool!.query<{ name: string; transfer_account_id: string }>(
      'SELECT name, transfer_account_id FROM payees WHERE id = $1',
      [acc.transfer_payee_id],
    );
    expect(payee.rows[0]).toEqual({ name: 'Transfer : Fresh Account', transfer_account_id: acc.id });
  });
});

describe('PATCH /accounts/:id/reconcile — stated balance is the working balance', () => {
  const reconcile = (id: string, body: Record<string, unknown>) =>
    app.request(`/accounts/${id}/reconcile`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, ...body }),
    });

  test.skipIf(!dbReady)('cleared + uncleared + override: working balance ends exactly at the stated value', async () => {
    const accRes = await app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, name: 'Reconcile Me', type: 'checking', user_id: null }),
    });
    const acc = (await accRes.json()) as { id: string };
    await pool!.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, memo, cleared, approved)
       VALUES ($1, $3, $4, '2025-03-01', 100000, '', 'cleared', true),
              ($2, $3, $4, '2025-03-02', -30000, '', 'uncleared', true)`,
      [crypto.randomUUID(), crypto.randomUUID(), budgetId, acc.id],
    );
    await pool!.query('UPDATE accounts SET cleared_balance = 100000, uncleared_balance = -30000 WHERE id = $1', [acc.id]);
    // Working-balance override: lands in uncleared with no ledger row (+5000 cents).
    const ov = await app.request(`/accounts/${acc.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: budgetId, working_balance: 120000 }),
    });
    expect(ov.status).toBe(200);

    // Stated 50.00 = 5000 cents; ledger sum is 70000 milli -> adjustment -20000.
    const res = await reconcile(acc.id, { stated_balance: 50000 });
    expect(res.status).toBe(204);

    const bal = await pool!.query<{ cleared_balance: string; uncleared_balance: string }>(
      'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
      [acc.id],
    );
    expect(Number(bal.rows[0].cleared_balance)).toBe(50000);
    expect(Number(bal.rows[0].uncleared_balance)).toBe(0);
    const rows = await pool!.query<{ amount: string; cleared: string; memo: string }>(
      'SELECT amount, cleared, memo FROM transactions WHERE account_id = $1 AND NOT deleted ORDER BY date, amount',
      [acc.id],
    );
    expect(rows.rows.every((r) => r.cleared === 'reconciled')).toBe(true);
    const adj = rows.rows.find((r) => r.memo === 'auto');
    expect(Number(adj?.amount)).toBe(-20000);
    expect(rows.rows.reduce((s, r) => s + Number(r.amount), 0)).toBe(50000);
  });
});

describe('POST /accounts credit card payment category', () => {
  let ccBudget = '';
  const create = async (name: string, type: string, on_budget = true, bid = ccBudget) => {
    const res = await app.request('/accounts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, name, type, on_budget, user_id: null }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string };
  };
  const cats = async (name: string, bid = ccBudget) =>
    (
      await pool!.query<{ id: string; deleted: boolean; is_ccp: boolean }>(
        `SELECT c.id, c.deleted, g.is_credit_card_payments AS is_ccp
           FROM categories c JOIN category_groups g ON g.id = c.group_id
          WHERE c.budget_id = $1 AND c.name = $2`,
        [bid, name],
      )
    ).rows;

  beforeAll(async () => {
    if (!dbReady || !pool) return;
    ccBudget = crypto.randomUUID();
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [
      ccBudget,
      'cc-payment-test',
      testUserId,
    ]);
  });
  afterAll(async () => {
    if (dbReady && pool && ccBudget) await pool.query('DELETE FROM budgets WHERE id = $1', [ccBudget]);
  });

  test.skipIf(!dbReady)('creating a card makes its payment category, and the missing group', async () => {
    await create('Nubank', 'creditCard');
    const rows = await cats('Nubank');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.is_ccp).toBe(true);
    const g = await pool!.query<{ internal: boolean; sort_order: number }>(
      'SELECT internal, sort_order FROM category_groups WHERE budget_id = $1 AND is_credit_card_payments',
      [ccBudget],
    );
    expect(g.rows).toEqual([{ internal: true, sort_order: 0 }]);
  });

  test.skipIf(!dbReady)('a second card gets its own category in the same group', async () => {
    await create('Itau Card', 'creditCard');
    const a = await cats('Nubank');
    const b = await cats('Itau Card');
    expect(b).toHaveLength(1);
    const groups = await pool!.query(
      'SELECT 1 FROM category_groups WHERE budget_id = $1 AND is_credit_card_payments AND NOT deleted',
      [ccBudget],
    );
    expect(groups.rows).toHaveLength(1);
    expect(a[0]!.id).not.toBe(b[0]!.id);
  });

  test.skipIf(!dbReady)('non-card and off-budget card create no category', async () => {
    await create('Checking CC', 'checking');
    await create('Tracking Card', 'creditCard', false);
    expect(await cats('Checking CC')).toHaveLength(0);
    expect(await cats('Tracking Card')).toHaveLength(0);
  });

  test.skipIf(!dbReady)('an existing same-name category in the group is reused', async () => {
    const g = await pool!.query<{ id: string }>(
      'SELECT id FROM category_groups WHERE budget_id = $1 AND is_credit_card_payments',
      [ccBudget],
    );
    await pool!.query('INSERT INTO categories (budget_id, group_id, name) VALUES ($1, $2, $3)', [
      ccBudget,
      g.rows[0]!.id,
      'Pre Card',
    ]);
    await create('Pre Card', 'creditCard');
    expect(await cats('Pre Card')).toHaveLength(1);
  });

  test.skipIf(!dbReady)('renaming a card renames its payment category', async () => {
    const acc = await create('Old Card', 'creditCard');
    const res = await app.request(`/accounts/${acc.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: ccBudget, name: 'New Card' }),
    });
    expect(res.status).toBe(200);
    expect(await cats('Old Card')).toHaveLength(0);
    expect(await cats('New Card')).toHaveLength(1);
  });
});
