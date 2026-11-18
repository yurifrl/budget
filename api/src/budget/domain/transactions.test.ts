/**
 * Server-derived balance deltas (optional `deltas` on transaction writes).
 *
 * Pure part: deriveDeltas must equal a reference old->new bucket model (the
 * arithmetic the app used to do itself before it stopped sending deltas) for
 * add / edit / move / clear-flip / delete. DB part: the same sequence of
 * writes through the real routes leaves identical balances whether the
 * client supplies its deltas or omits them; supplied deltas stay verbatim.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';
import { deriveDeltas, type BalanceDelta, type LedgerRow } from './transactions';

type Cleared = LedgerRow['cleared'];
interface Txn {
  accountId: string;
  /** cents */
  outflow: number;
  inflow: number;
  cleared: Cleared;
}

const A = '00000000-0000-4000-8000-00000000000a';
const B = '00000000-0000-4000-8000-00000000000b';

const toRow = (t: Txn): LedgerRow => ({ account_id: t.accountId, amount: (t.inflow - t.outflow) * 10, cleared: t.cleared });
/** Reference model: cents moved into the cleared/uncleared bucket of each account (reconciled counts as cleared). */
function clientDeltas(oldTxn: Txn | null, newTxn: Txn | null) {
  const byAccount = new Map<string, { clearedDelta: number; unclearedDelta: number }>();
  const apply = (t: Txn, sign: 1 | -1) => {
    const d = byAccount.get(t.accountId) ?? { clearedDelta: 0, unclearedDelta: 0 };
    const amount = sign * (t.inflow - t.outflow);
    if (t.cleared === 'uncleared') d.unclearedDelta += amount;
    else d.clearedDelta += amount;
    byAccount.set(t.accountId, d);
  };
  if (oldTxn) apply(oldTxn, -1);
  if (newTxn) apply(newTxn, 1);
  return [...byAccount.entries()]
    .map(([accountId, d]) => ({ accountId, ...d }))
    .filter((d) => d.clearedDelta !== 0 || d.unclearedDelta !== 0);
}
const asServerShape = (txn: Txn | null, other: Txn | null): BalanceDelta[] =>
  clientDeltas(txn, other).map((d) => ({ account_id: d.accountId, cleared_delta: d.clearedDelta, uncleared_delta: d.unclearedDelta }));

describe('deriveDeltas == reference bucket model', () => {
  const base: Txn = { accountId: A, outflow: 1250, inflow: 0, cleared: 'uncleared' };
  const cases: Array<[string, Txn | null, Txn | null]> = [
    ['add outflow (uncleared)', null, base],
    ['add inflow (cleared)', null, { ...base, outflow: 0, inflow: 9999, cleared: 'cleared' }],
    ['add reconciled counts as cleared', null, { ...base, cleared: 'reconciled' }],
    ['add zero amount -> no delta', null, { ...base, outflow: 0 }],
    ['edit amount', base, { ...base, outflow: 3000 }],
    ['edit direction (outflow -> inflow)', base, { ...base, outflow: 0, inflow: 500 }],
    ['clear flip uncleared -> cleared', base, { ...base, cleared: 'cleared' }],
    ['clear flip cleared -> reconciled is a no-op', { ...base, cleared: 'cleared' }, { ...base, cleared: 'reconciled' }],
    ['move account', base, { ...base, accountId: B }],
    ['move account + amount + cleared', base, { accountId: B, outflow: 0, inflow: 77, cleared: 'cleared' }],
    ['delete uncleared', base, null],
    ['delete cleared inflow', { ...base, outflow: 0, inflow: 4200, cleared: 'cleared' }, null],
    ['unchanged edit -> no delta', base, { ...base }],
    ['split parent (leg sum) add', null, { ...base, outflow: 0, inflow: 100 - 4000 + 5000 }],
  ];
  for (const [label, before, after] of cases) {
    test(label, () => {
      const derived = deriveDeltas(before ? toRow(before) : null, after ? toRow(after) : null);
      expect(derived).toEqual(asServerShape(before, after));
    });
  }

  test('accepts the numeric-string amounts pg returns for bigint columns', () => {
    expect(deriveDeltas(null, { account_id: A, amount: '-12500', cleared: 'cleared' })).toEqual([
      { account_id: A, cleared_delta: -1250, uncleared_delta: 0 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// DB: route-level equivalence
// ---------------------------------------------------------------------------

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

const { Hono } = await import('hono');
const routeApp = (await import('../routes/transactions')).default;
const app = new Hono();
app.onError((await import('../../core/validate')).httpOnError);
const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'derive-deltas@syscd.local', googleSub: null, role: 'user', status: 'active' };
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/transactions', routeApp);

const budgetId = crypto.randomUUID();
/** Two parallel accounts pairs: lane "client" sends deltas, lane "server" omits them. */
const lanes = {
  client: { a: crypto.randomUUID(), b: crypto.randomUUID() },
  server: { a: crypto.randomUUID(), b: crypto.randomUUID() },
};
const categoryId = crypto.randomUUID();
const groupId = crypto.randomUUID();

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function balances(accountId: string): Promise<{ cleared: number; uncleared: number }> {
  const r = await pool!.query<{ cleared_balance: string; uncleared_balance: string }>(
    'SELECT cleared_balance, uncleared_balance FROM accounts WHERE id = $1',
    [accountId],
  );
  return { cleared: Number(r.rows[0].cleared_balance), uncleared: Number(r.rows[0].uncleared_balance) };
}

beforeAll(async () => {
  if (!dbReady) return;
  await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [userId, user.email]);
  await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'derive-deltas', userId]);
  await pool!.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, userId]);
  await pool!.query('INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, $3, 0)', [groupId, budgetId, 'g']);
  await pool!.query('INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4, 0)', [categoryId, budgetId, groupId, 'c']);
  for (const [lane, ids] of Object.entries(lanes)) {
    for (const [k, id] of Object.entries(ids)) {
      await pool!.query(
        `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES ($1, $2, $3, 'checking', 'CASH')`,
        [id, budgetId, `${lane}-${k}`],
      );
    }
  }
});

afterAll(async () => {
  if (!dbReady) return;
  await pool!.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await pool!.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

describe.skipIf(!dbReady)('transaction writes: server-derived deltas (client-supplied deltas are ignored, G13)', () => {
  /** Mirror of a row's ledger state, as the client keeps it. */
  type Tracked = Txn & { id: string };

  /** Run one write in a lane; `client` lane sends ledger.accountDeltas, `server` lane omits deltas. */
  async function create(lane: 'client' | 'server', txn: Txn, subtransactions?: unknown[]): Promise<Tracked> {
    const body: Record<string, unknown> = {
      budget_id: budgetId,
      txn: {
        account_id: txn.accountId,
        date: '2025-04-01',
        payee: 'Shop',
        category_id: subtransactions ? null : categoryId,
        memo: '',
        outflow_cents: txn.outflow,
        inflow_cents: txn.inflow,
        cleared: txn.cleared,
        approved: true,
        flag: null,
        repeat: 'never',
      },
    };
    if (subtransactions) body.subtransactions = subtransactions;
    if (lane === 'client') body.deltas = asServerShape(null, txn);
    const res = await send('POST', '/transactions', body);
    expect(res.status).toBe(201);
    return { ...txn, id: ((await res.json()) as { id: string }).id };
  }

  async function patch(lane: 'client' | 'server', before: Tracked, after: Txn, extra: Record<string, unknown> = {}): Promise<Tracked> {
    const patchBody: Record<string, unknown> = {
      account_id: after.accountId,
      outflow_cents: after.outflow,
      inflow_cents: after.inflow,
      cleared: after.cleared,
      ...extra,
    };
    const body: Record<string, unknown> = { budget_id: budgetId, patch: patchBody };
    if (lane === 'client') body.deltas = asServerShape(before, after);
    const res = await send('PATCH', `/transactions/${before.id}`, body);
    expect(res.status).toBe(204);
    return { ...after, id: before.id };
  }

  async function remove(lane: 'client' | 'server', before: Tracked): Promise<void> {
    const res = await send(
      'DELETE',
      `/transactions/${before.id}?budget_id=${budgetId}`,
      lane === 'client' ? { deltas: asServerShape(before, null) } : undefined,
    );
    expect(res.status).toBe(204);
  }

  const mk = (laneIds: { a: string; b: string }, which: 'a' | 'b', t: Omit<Txn, 'accountId'>): Txn => ({ ...t, accountId: laneIds[which] });

  async function expectLanesEqual(label: string) {
    for (const k of ['a', 'b'] as const) {
      const c = await balances(lanes.client[k]);
      const s = await balances(lanes.server[k]);
      expect(s, `${label} (account ${k})`).toEqual(c);
    }
  }

  test('create / edit amount / clear flip / move account / delete stay in lockstep', async () => {
    const run = async (lane: 'client' | 'server') => {
      const ids = lanes[lane];
      let t = await create(lane, mk(ids, 'a', { outflow: 4500, inflow: 0, cleared: 'uncleared' }));
      const cleared = await create(lane, mk(ids, 'a', { outflow: 0, inflow: 20000, cleared: 'cleared' }));
      t = await patch(lane, t, { ...t, outflow: 6000 });
      t = await patch(lane, t, { ...t, cleared: 'cleared' });
      t = await patch(lane, t, { ...t, accountId: ids.b });
      t = await patch(lane, t, { ...t, accountId: ids.a, outflow: 0, inflow: 1234, cleared: 'uncleared' });
      await remove(lane, cleared);
      return t;
    };
    await run('client');
    await run('server');
    await expectLanesEqual('after lifecycle');
    // Sanity: the expected absolute numbers, not just lane equality.
    // Remaining live row: +1234 uncleared on account a (everything else was reversed or moved away).
    expect(await balances(lanes.server.a)).toEqual({ cleared: 0, uncleared: 1234 * 10 });
    expect(await balances(lanes.server.b)).toEqual({ cleared: 0, uncleared: 0 });
  });

  test('split transactions: the parent amount is the leg sum on both paths', async () => {
    const legs = [
      { category_id: categoryId, memo: 'a', outflow_cents: 3000, inflow_cents: 0 },
      { category_id: null, memo: 'b', outflow_cents: 0, inflow_cents: 500 },
    ];
    const total: Omit<Txn, 'accountId'> = { outflow: 2500, inflow: 0, cleared: 'cleared' };
    const before = { client: await balances(lanes.client.b), server: await balances(lanes.server.b) };
    const c = await create('client', mk(lanes.client, 'b', total), legs);
    const s = await create('server', mk(lanes.server, 'b', total), legs);
    const afterCreate = { client: await balances(lanes.client.b), server: await balances(lanes.server.b) };
    expect(afterCreate.server.cleared - before.server.cleared).toBe(-2500 * 10);
    expect(afterCreate.server).toEqual(afterCreate.client);
    await remove('client', c);
    await remove('server', s);
    expect(await balances(lanes.server.b)).toEqual(before.server);
    expect(await balances(lanes.client.b)).toEqual(before.client);
  });

  test('client-supplied deltas are ignored (G13): the schema strips them, the server derives', async () => {
    const before = await balances(lanes.client.a);
    const body = (outflow: number, deltas: unknown) => ({
      budget_id: budgetId,
      txn: {
        account_id: lanes.client.a,
        date: '2025-04-02',
        payee: '',
        category_id: null,
        memo: '',
        outflow_cents: outflow,
        inflow_cents: 0,
        cleared: 'uncleared',
        approved: true,
        flag: null,
        repeat: '',
      },
      deltas,
    });
    // Deliberately NOT what the server would derive; it must lose.
    const res = await send('POST', '/transactions', body(100, [{ account_id: lanes.client.a, cleared_delta: 7, uncleared_delta: 0 }]));
    expect(res.status).toBe(201);
    const after = await balances(lanes.client.a);
    expect(after.cleared - before.cleared).toBe(0);
    expect(after.uncleared - before.uncleared).toBe(-1000);
    // An explicit empty list can no longer mean "move nothing".
    const res2 = await send('POST', '/transactions', body(999, []));
    expect(res2.status).toBe(201);
    const after2 = await balances(lanes.client.a);
    expect(after2.uncleared - after.uncleared).toBe(-9990);
    // Same on delete: a forged reversal list does not stop the real reversal.
    const created = (await res2.json()) as { id: string };
    const del = await send('DELETE', `/transactions/${created.id}?budget_id=${budgetId}`, { deltas: [] });
    expect(del.status).toBe(204);
    expect(await balances(lanes.client.a)).toEqual(after);
  });

  test('deleting a pending upcoming occurrence derives no delta (its delta was withheld)', async () => {
    const accountId = lanes.server.a;
    const before = await balances(accountId);
    const ins = await pool!.query<{ id: string }>(
      `INSERT INTO transactions (budget_id, account_id, date, amount, cleared, approved, repeat, upcoming, deleted)
       VALUES ($1, $2, '2099-01-01', -50000, 'uncleared', true, 'monthly', true, false) RETURNING id`,
      [budgetId, accountId],
    );
    const res = await send('DELETE', `/transactions/${ins.rows[0].id}?budget_id=${budgetId}`);
    expect(res.status).toBe(204);
    expect(await balances(accountId)).toEqual(before);
  });

  test('bulk clear: patching only `cleared` with no deltas moves the balance between buckets', async () => {
    const ids = lanes.server;
    const before = await balances(ids.b);
    const rows = [
      await create('server', mk(ids, 'b', { outflow: 1000, inflow: 0, cleared: 'uncleared' })),
      await create('server', mk(ids, 'b', { outflow: 0, inflow: 400, cleared: 'uncleared' })),
    ];
    const afterAdd = await balances(ids.b);
    expect(afterAdd).toEqual({ cleared: before.cleared, uncleared: before.uncleared + (400 - 1000) * 10 });
    // The app's "clear selected": one PATCH per row, patch = { cleared }, NO deltas key.
    for (const r of rows) {
      const res = await send('PATCH', `/transactions/${r.id}`, { budget_id: budgetId, patch: { cleared: 'cleared' } });
      expect(res.status).toBe(204);
    }
    expect(await balances(ids.b)).toEqual({ cleared: before.cleared + (400 - 1000) * 10, uncleared: before.uncleared });
    for (const r of rows) await remove('server', { ...r, cleared: 'cleared' });
    expect(await balances(ids.b)).toEqual(before);
  });

  test('deleting an upcoming occurrence with no deltas leaves balances unchanged while a normal delete reverses', async () => {
    const accountId = lanes.server.a;
    const live = await create('server', mk(lanes.server, 'a', { outflow: 700, inflow: 0, cleared: 'uncleared' }));
    const withLive = await balances(accountId);
    const ins = await pool!.query<{ id: string }>(
      `INSERT INTO transactions (budget_id, account_id, date, amount, cleared, approved, repeat, upcoming, deleted)
       VALUES ($1, $2, '2099-02-01', -90000, 'uncleared', true, 'monthly', true, false) RETURNING id`,
      [budgetId, accountId],
    );
    expect((await send('DELETE', `/transactions/${ins.rows[0].id}?budget_id=${budgetId}`)).status).toBe(204);
    expect(await balances(accountId)).toEqual(withLive);
    expect((await send('DELETE', `/transactions/${live.id}?budget_id=${budgetId}`)).status).toBe(204);
    expect(await balances(accountId)).toEqual({ cleared: withLive.cleared, uncleared: withLive.uncleared + 700 * 10 });
  });

  test('a foreign or already-deleted transaction is still 404 with no balance change', async () => {
    const before = await balances(lanes.server.a);
    const res = await send('DELETE', `/transactions/${crypto.randomUUID()}?budget_id=${budgetId}`);
    expect(res.status).toBe(404);
    expect(await balances(lanes.server.a)).toEqual(before);
  });
});
