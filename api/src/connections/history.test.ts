/**
 * connections_accounts_summary + connections_transactions_list: per-account
 * counts, per-account isolation, keyset pagination, ownership 404s. DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { pool } from '../core/db';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import connectionsApp from './routes';
import { upsertConnection } from './store';

let dbReady = false;
try {
  await pool.query('SELECT 1');
  dbReady = (await pool.query("select to_regclass('public.connection_transactions')::text as t")).rows[0]?.t != null;
} catch {
  dbReady = false;
}

const mkUser = (tag: string): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `connections-history-${tag}@syscd.local`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const alice = mkUser('alice');
const bob = mkUser('bob');
let current: IdentityUser = alice;

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', current);
  return next();
});
app.route('/connections', connectionsApp);

const get = async (path: string) => {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as any };
};

describe.skipIf(!dbReady)('connection history reads', () => {
  const budgetId = crypto.randomUUID();
  const acc1 = crypto.randomUUID();
  const acc2 = crypto.randomUUID();
  const unlinked = crypto.randomUUID();
  let connectionId = '';

  async function addTxn(accountId: string, date: string, opts: { blocked?: boolean; deleted?: boolean } = {}) {
    const id = crypto.randomUUID();
    await pool.query(
      `INSERT INTO transactions (id, budget_id, account_id, date, amount, memo, cleared, approved, deleted, import_id, import_payee_name)
       VALUES ($1, $2, $3, $4, -12340, 'm', 'cleared', false, $5, $6, 'Shop')`,
      [id, budgetId, accountId, date, opts.deleted ?? false, `t:${id}`],
    );
    await pool.query(
      `INSERT INTO connection_transactions (transaction_id, provider, external_transaction_id, blocked)
       VALUES ($1, 'hist-test', $2, $3)`,
      [id, id, opts.blocked ?? false],
    );
    return id;
  }

  beforeAll(async () => {
    for (const u of [alice, bob]) {
      await pool.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [u.id, u.email]);
    }
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'connections-history-test', alice.id]);
    const conn = await upsertConnection({ userId: alice.id, provider: 'hist-test', externalId: `h-${crypto.randomUUID()}`, status: 'connected' });
    connectionId = conn.id;
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group, connection_id, external_account_id)
       VALUES ($1, $4, 'Linked One', 'checking', 'CASH', $5, 'ext-1'),
              ($2, $4, 'Linked Two', 'checking', 'CASH', $5, 'ext-2'),
              ($3, $4, 'Plain', 'checking', 'CASH', NULL, NULL)`,
      [acc1, acc2, unlinked, budgetId, connectionId],
    );
    // acc1: 5 imported across 3 dates (two share a date), 1 edited, 1 removed
    for (const d of ['2026-01-01', '2026-01-02', '2026-01-02', '2026-01-03', '2026-01-04']) await addTxn(acc1, d);
    await addTxn(acc1, '2026-01-05', { blocked: true });
    await addTxn(acc1, '2026-01-06', { deleted: true });
    await addTxn(acc2, '2026-02-01');
  });
  afterAll(async () => {
    await pool.query('DELETE FROM public.budgets WHERE id = $1', [budgetId]);
    await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[alice.id, bob.id]]);
  });

  test('summary: per-account counts, date range and totals', async () => {
    current = alice;
    const { status, body } = await get(`/connections/${connectionId}/summary`);
    expect(status).toBe(200);
    const one = body.accounts.find((a: any) => a.accountId === acc1);
    expect(one).toMatchObject({
      // The account's own budget: the client scopes link edits by it.
      budgetId,
      name: 'Linked One',
      externalAccountId: 'ext-1',
      importedCount: 5,
      editedCount: 1,
      removedCount: 1,
      totalCount: 7,
      firstDate: '2026-01-01',
      lastDate: '2026-01-05',
    });
    expect(body.accounts).toHaveLength(2);
    expect(body.totals).toEqual({ importedCount: 6, editedCount: 1, removedCount: 1, totalCount: 8 });
  });

  test('list: newest first, keyset pages never repeat or mix accounts, terminate with null cursor', async () => {
    current = alice;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = `/connections/${connectionId}/transactions?accountId=${acc1}&limit=3${cursor ? `&cursor=${cursor}` : ''}`;
      const { status, body } = await get(q);
      expect(status).toBe(200);
      pages += 1;
      for (const item of body.items) seen.push(item.id);
      expect(body.items.length).toBeLessThanOrEqual(3);
      cursor = body.nextCursor;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const all = await get(`/connections/${connectionId}/transactions?accountId=${acc1}`);
    expect(all.body.items.map((i: any) => i.date)).toEqual(
      ['2026-01-06', '2026-01-05', '2026-01-04', '2026-01-03', '2026-01-02', '2026-01-02', '2026-01-01'],
    );
    expect(all.body.items.map((i: any) => i.state).slice(0, 2)).toEqual(['removed', 'edited']);
    expect(all.body.items[0]).toMatchObject({ amount: -12340, payee: 'Shop', cleared: 'cleared', memo: 'm' });
    expect(all.body.nextCursor).toBeNull();
    const two = await get(`/connections/${connectionId}/transactions?accountId=${acc2}`);
    expect(two.body.items).toHaveLength(1);
  });

  test('validation and ownership', async () => {
    current = alice;
    expect((await get(`/connections/${connectionId}/transactions?accountId=${acc1}&limit=201`)).status).toBe(400);
    expect((await get(`/connections/${connectionId}/transactions?accountId=${acc1}&cursor=garbage`)).status).toBe(400);
    // an account not linked to this connection is a 404, never someone else's rows
    expect((await get(`/connections/${connectionId}/transactions?accountId=${unlinked}`)).status).toBe(404);
    current = bob;
    expect((await get(`/connections/${connectionId}/summary`)).status).toBe(404);
    expect((await get(`/connections/${connectionId}/transactions?accountId=${acc1}`)).status).toBe(404);
  });
});
