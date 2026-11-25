/**
 * Transfers (mirrored legs) through the real transaction operations.
 *
 * DB-backed, in-process via app.request() — same harness as
 * domain/transactions.test.ts. Every scenario runs in two lanes:
 *   - "client": the old app build still sends deltas for ITS account only;
 *   - "none":   the caller sends no deltas at all.
 * and after EVERY write the cached cleared/uncleared balances of every account
 * must equal a fresh sum over the ledger (the invariant that proves both legs
 * were derived by deriveDeltas and nothing was applied twice or not at all).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Pool } from 'pg';

import type { IdentityUser } from '../../user';
import { deriveDeltas, type BalanceDelta, type LedgerRow } from '../domain/transactions';

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

const routeApp = (await import('./transactions')).default;
const app = new (await import('hono')).Hono();
app.onError((await import('../../core/validate')).httpOnError);
const userId = crypto.randomUUID();
const user: IdentityUser = { id: userId, email: 'transfers@syscd.local', googleSub: null, role: 'user', status: 'active' };
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/transactions', routeApp);

const budgetId = crypto.randomUUID();
const groupId = crypto.randomUUID();
const categoryId = crypto.randomUUID();

type Lane = 'client' | 'none';
interface LaneAccounts {
  cash: string; // legacy: no transfer payee yet
  itau: string; // seeded with a linked transfer payee
  third: string; // legacy
  house: string; // off budget (tracking)
  closed: string;
  names: Record<'cash' | 'itau' | 'third' | 'house' | 'closed', string>;
}
const lanes: Record<Lane, LaneAccounts> = {
  client: mkLane('client'),
  none: mkLane('none'),
};
function mkLane(lane: string): LaneAccounts {
  const n = { cash: `${lane} Cash`, itau: `${lane} Itau`, third: `${lane} Third`, house: `${lane} House`, closed: `${lane} Closed` };
  return {
    cash: crypto.randomUUID(),
    itau: crypto.randomUUID(),
    third: crypto.randomUUID(),
    house: crypto.randomUUID(),
    closed: crypto.randomUUID(),
    names: n,
  };
}

const send = (method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

interface Leg {
  id: string;
  account_id: string;
  amount: string;
  cleared: LedgerRow['cleared'];
  category_id: string | null;
  payee_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  deleted: boolean;
}
const getRow = async (id: string): Promise<Leg> =>
  (await pool!.query<Leg>('SELECT * FROM transactions WHERE id = $1', [id])).rows[0]!;
const payeeName = async (id: string | null) =>
  id ? (await pool!.query<{ name: string }>('SELECT name FROM payees WHERE id = $1', [id])).rows[0]!.name : null;

/** Cached balances must equal a fresh sum over the live ledger, per bucket, for each account. */
async function expectLedgerConsistent(ids: string[]) {
  for (const id of ids) {
    const cached = (await pool!.query('SELECT cleared_balance AS c, uncleared_balance AS u FROM accounts WHERE id = $1', [id])).rows[0];
    const fresh = (
      await pool!.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE cleared <> 'uncleared'), 0) AS c,
                COALESCE(SUM(amount) FILTER (WHERE cleared = 'uncleared'), 0) AS u
         FROM transactions WHERE account_id = $1 AND deleted = false`,
        [id],
      )
    ).rows[0];
    expect([Number(cached.c), Number(cached.u)]).toEqual([Number(fresh.c), Number(fresh.u)]);
  }
}
const balances = async (id: string) => {
  const r = (await pool!.query('SELECT cleared_balance AS c, uncleared_balance AS u FROM accounts WHERE id = $1', [id])).rows[0];
  return [Number(r.c), Number(r.u)];
};

beforeAll(async () => {
  if (!dbReady) return;
  await (await import('../../core/migrate')).runMigrations();
  await pool!.query(`INSERT INTO public.users (id, google_sub, email, role, status) VALUES ($1, null, $2, 'user', 'active')`, [userId, user.email]);
  await pool!.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, $2, $3)', [budgetId, 'xfer-test', userId]);
  await pool!.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [budgetId, userId]);
  await pool!.query('INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, $3, 0)', [groupId, budgetId, 'g']);
  await pool!.query('INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, $4, 0)', [categoryId, budgetId, groupId, 'c']);
  for (const l of Object.values(lanes)) {
    for (const k of ['cash', 'itau', 'third', 'house', 'closed'] as const) {
      await pool!.query(
        `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget, closed) VALUES ($1, $2, $3, 'checking', 'CASH', $4, $5)`,
        [l[k], budgetId, l.names[k], k !== 'house', k === 'closed'],
      );
    }
    // Itau is "seeded" the way POST /accounts now does it: a linked transfer payee.
    const p = await pool!.query<{ id: string }>(
      `INSERT INTO payees (budget_id, name, transfer_account_id) VALUES ($1, $2, $3) RETURNING id`,
      [budgetId, `Transfer : ${l.names.itau}`, l.itau],
    );
    await pool!.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [p.rows[0].id, l.itau]);
  }
});

afterAll(async () => {
  if (!dbReady) return;
  await pool!.query('DELETE FROM budgets WHERE id = $1', [budgetId]);
  await pool!.query('DELETE FROM public.users WHERE id = $1', [userId]);
});

for (const lane of ['client', 'none'] as const) {
  const A = lanes[lane];
  const xfer = (k: 'cash' | 'itau' | 'third' | 'house' | 'closed') => `Transfer : ${A.names[k]}`;
  const all = [A.cash, A.itau, A.third, A.house];

  /** The deltas an OLD client would send for its own row (none in the "none" lane). */
  const own = (before: LedgerRow | null, after: LedgerRow | null): { deltas?: BalanceDelta[] } =>
    lane === 'client' ? { deltas: deriveDeltas(before, after) } : {};
  const led = (account_id: string, milli: number, cleared: LedgerRow['cleared'] = 'uncleared'): LedgerRow => ({
    account_id,
    amount: milli,
    cleared,
  });

  const txn = (over: Record<string, unknown> = {}) => ({
    account_id: A.cash,
    date: '2025-07-01',
    payee: xfer('itau'),
    category_id: null,
    memo: 'm',
    outflow: 200000,
    inflow: 0,
    cleared: 'uncleared',
    approved: true,
    flag: null,
    repeat: 'never',
    ...over,
  });

  async function create(over: Record<string, unknown> = {}) {
    const t = txn(over) as ReturnType<typeof txn> & { outflow: number; inflow: number };
    const milli = (t.inflow as number) - (t.outflow as number);
    const res = await send('POST', '/transactions', {
      budget_id: budgetId,
      txn: t,
      ...own(null, led(t.account_id, milli, t.cleared as LedgerRow['cleared'])),
    });
    return { res, body: res.status === 201 ? ((await res.json()) as Leg) : null, milli };
  }
  async function patch(id: string, p: Record<string, unknown>) {
    const before = await getRow(id);
    // Compute the client-side "after" by applying the patch to the stored row.
    const after: LedgerRow = {
      account_id: (p.account_id as string) ?? before.account_id,
      amount:
        p.outflow !== undefined || p.inflow !== undefined
          ? ((p.inflow as number) ?? 0) - ((p.outflow as number) ?? 0)
          : before.amount,
      cleared: (p.cleared as LedgerRow['cleared']) ?? before.cleared,
    };
    return send('PATCH', `/transactions/${id}`, {
      budget_id: budgetId,
      patch: p,
      ...own({ account_id: before.account_id, amount: before.amount, cleared: before.cleared }, after),
    });
  }
  async function remove(id: string) {
    const before = await getRow(id);
    return send('DELETE', `/transactions/${id}?budget_id=${budgetId}`, lane === 'client' ? { deltas: deriveDeltas(before, null) } : undefined);
  }

  describe.skipIf(!dbReady)(`transfers (${lane} lane)`, () => {
    test('create: two rows reference each other, opposite amounts, no category, each balance moved by its own leg', async () => {
      // QA Cash has no linked payee yet: it is linked on first use. A category is sent and must be dropped.
      const { res, body } = await create({ category_id: categoryId });
      expect(res.status).toBe(201);
      const src = await getRow(body!.id);
      const mirror = await getRow(src.transfer_transaction_id!);
      expect(mirror.transfer_transaction_id).toBe(src.id);
      expect(src.transfer_account_id).toBe(A.itau);
      expect(mirror.transfer_account_id).toBe(A.cash);
      expect(src.account_id).toBe(A.cash);
      expect(mirror.account_id).toBe(A.itau);
      expect(Number(src.amount)).toBe(-200000);
      expect(Number(mirror.amount)).toBe(200000);
      expect(src.category_id).toBeNull();
      expect(mirror.category_id).toBeNull();
      expect(body!.transfer_transaction_id).toBe(mirror.id); // response reflects the link
      expect(await payeeName(src.payee_id)).toBe(xfer('itau'));
      expect(await payeeName(mirror.payee_id)).toBe(xfer('cash'));
      expect(await balances(A.cash)).toEqual([0, -200000]);
      expect(await balances(A.itau)).toEqual([0, 200000]);
      const link = await pool!.query('SELECT transfer_payee_id FROM accounts WHERE id = $1', [A.cash]);
      expect(link.rows[0].transfer_payee_id).not.toBeNull();
      await expectLedgerConsistent(all);
      await remove(src.id);
    });

    test('create cleared inflow moves the CLEARED bucket of both accounts', async () => {
      const { body } = await create({ outflow: 0, inflow: 50000, cleared: 'cleared' });
      const src = await getRow(body!.id);
      const mirror = await getRow(src.transfer_transaction_id!);
      expect(mirror.cleared).toBe('cleared');
      expect(await balances(A.cash)).toEqual([50000, 0]);
      expect(await balances(A.itau)).toEqual([-50000, 0]);
      await expectLedgerConsistent(all);
      await remove(src.id);
    });

    test('edit amount updates the mirror and both balances', async () => {
      const { body } = await create({ outflow: 10000 });
      expect((await patch(body!.id, { outflow: 15000, inflow: 0 })).status).toBe(204);
      const src = await getRow(body!.id);
      expect(Number((await getRow(src.transfer_transaction_id!)).amount)).toBe(15000);
      expect(await balances(A.itau)).toEqual([0, 15000]);
      await expectLedgerConsistent(all);
      // direction flip
      expect((await patch(body!.id, { outflow: 0, inflow: 3000 })).status).toBe(204);
      expect(Number((await getRow(src.transfer_transaction_id!)).amount)).toBe(-3000);
      await expectLedgerConsistent(all);
      await remove(body!.id);
    });

    test('moving a leg to a different account re-points the mirror and keeps every balance equal to the ledger', async () => {
      const { body } = await create({ outflow: 7000 });
      expect((await patch(body!.id, { account_id: A.third })).status).toBe(204);
      const src = await getRow(body!.id);
      const mirror = await getRow(src.transfer_transaction_id!);
      expect(src.account_id).toBe(A.third);
      expect(src.transfer_account_id).toBe(A.itau);
      expect(mirror.account_id).toBe(A.itau);
      expect(mirror.transfer_account_id).toBe(A.third);
      expect(await payeeName(mirror.payee_id)).toBe(xfer('third'));
      expect(await balances(A.cash)).toEqual([0, 0]);
      expect(await balances(A.third)).toEqual([0, -7000]);
      expect(await balances(A.itau)).toEqual([0, 7000]);
      await expectLedgerConsistent(all);
      // Moving it onto its own peer would be a self-transfer: rejected, nothing changes.
      const self = await patch(body!.id, { account_id: A.itau });
      expect(self.status).toBe(400);
      expect(await self.json()).toEqual({ error: 'cannot transfer to the same account', code: 'cannot_transfer_to_same_account' });
      await expectLedgerConsistent(all);
      await remove(body!.id);
    });

    test('toggling cleared on one leg moves only that leg bucket', async () => {
      const { body } = await create({ outflow: 9000 });
      expect((await patch(body!.id, { cleared: 'cleared' })).status).toBe(204);
      const src = await getRow(body!.id);
      expect((await getRow(src.transfer_transaction_id!)).cleared).toBe('uncleared'); // each bank clears on its own
      expect(await balances(A.cash)).toEqual([-9000, 0]);
      expect(await balances(A.itau)).toEqual([0, 9000]);
      await expectLedgerConsistent(all);
      // and toggling the MIRROR leg moves only the other account
      expect((await patch(src.transfer_transaction_id!, { cleared: 'cleared' })).status).toBe(204);
      expect(await balances(A.itau)).toEqual([9000, 0]);
      expect(await balances(A.cash)).toEqual([-9000, 0]);
      await expectLedgerConsistent(all);
      await remove(body!.id);
    });

    test('plain -> transfer creates the mirror; transfer -> plain removes it; transfer -> other peer swaps it', async () => {
      const { body } = await create({ payee: 'Padaria', outflow: 7000, category_id: categoryId });
      expect((await getRow(body!.id)).transfer_transaction_id).toBeNull();
      expect(await balances(A.itau)).toEqual([0, 0]);

      // plain -> transfer; the category it carried is dropped (on-budget <-> on-budget)
      expect((await patch(body!.id, { payee: xfer('itau') })).status).toBe(204);
      let src = await getRow(body!.id);
      expect(src.transfer_transaction_id).not.toBeNull();
      expect(src.category_id).toBeNull();
      expect(await balances(A.itau)).toEqual([0, 7000]);
      await expectLedgerConsistent(all);

      // transfer -> another peer: old mirror gone (soft-deleted), new one in `third`
      expect((await patch(body!.id, { payee: xfer('third') })).status).toBe(204);
      src = await getRow(body!.id);
      const m = await getRow(src.transfer_transaction_id!);
      expect(m.account_id).toBe(A.third);
      expect(await balances(A.itau)).toEqual([0, 0]);
      expect(await balances(A.third)).toEqual([0, 7000]);
      await expectLedgerConsistent(all);

      // transfer -> plain
      expect((await patch(body!.id, { payee: 'Padaria' })).status).toBe(204);
      src = await getRow(body!.id);
      expect([src.transfer_transaction_id, src.transfer_account_id]).toEqual([null, null]);
      expect((await getRow(m.id)).deleted).toBe(true);
      expect(await balances(A.third)).toEqual([0, 0]);
      await expectLedgerConsistent(all);
      await remove(body!.id);
    });

    test('a category sent while editing an on-budget transfer is dropped', async () => {
      const { body } = await create({ outflow: 1000 });
      expect((await patch(body!.id, { category_id: categoryId })).status).toBe(204);
      expect((await getRow(body!.id)).category_id).toBeNull();
      await remove(body!.id);
    });

    for (const side of ['source', 'mirror'] as const) {
      test(`deleting the ${side} leg of a hand-made transfer deletes the other and reverses both balances (a bank row the matcher linked is restored instead: connections/transfer-integrity.test.ts)`, async () => {
        const { body } = await create({ outflow: 12340, cleared: 'cleared' });
        const src = await getRow(body!.id);
        const [victim, other] = side === 'source' ? [src.id, src.transfer_transaction_id!] : [src.transfer_transaction_id!, src.id];
        expect((await remove(victim)).status).toBe(204);
        expect((await getRow(victim)).deleted).toBe(true);
        expect((await getRow(other)).deleted).toBe(true);
        expect(await balances(A.cash)).toEqual([0, 0]);
        expect(await balances(A.itau)).toEqual([0, 0]);
        await expectLedgerConsistent(all);
      });
    }

    test('self transfer and split transfer are rejected with 400 { error } and leave nothing behind', async () => {
      const before = (await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [budgetId])).rows[0].n;
      const self = await create({ account_id: A.itau });
      expect(self.res.status).toBe(400);
      expect(await self.res.json()).toEqual({ error: 'cannot transfer to the same account', code: 'cannot_transfer_to_same_account' });

      const split = await send('POST', '/transactions', {
        budget_id: budgetId,
        txn: txn({ outflow: 0 }),
        subtransactions: [
          { outflow: 1000, inflow: 0, memo: '', category_id: categoryId },
          { outflow: 2000, inflow: 0, memo: '', category_id: categoryId },
        ],
      });
      expect(split.status).toBe(400);
      expect(await split.json()).toEqual({ error: 'a transfer cannot be split', code: 'transfer_cannot_be_split' });

      const after = (await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [budgetId])).rows[0].n;
      expect(after).toBe(before);
      await expectLedgerConsistent(all);
    });

    test('a transfer to a closed account is rejected (409)', async () => {
      const r = await create({ payee: xfer('closed') });
      expect(r.res.status).toBe(409);
      await expectLedgerConsistent([...all, A.closed]);
    });

    test('off-budget peer: single category-carrying leg stays categorized, mirror has none, balances still follow', async () => {
      const { body } = await create({ payee: xfer('house'), category_id: categoryId, outflow: 1000 });
      const src = await getRow(body!.id);
      expect(src.category_id).toBe(categoryId);
      expect((await getRow(src.transfer_transaction_id!)).category_id).toBeNull();
      expect(await balances(A.house)).toEqual([0, 1000]);
      await expectLedgerConsistent(all);
      await remove(body!.id);
    });

    test('atomic: a failure creating the mirror leaves no row and no balance change', async () => {
      // Make exactly the mirror insert (amount +7777770 milliunits in this account) blow up.
      const fn = `fail_mirror_${lane}`;
      await pool!.query(
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$
         BEGIN IF NEW.amount = 7777770 AND NEW.account_id = '${A.itau}' THEN RAISE EXCEPTION 'boom'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql`,
      );
      await pool!.query(`CREATE TRIGGER ${fn} BEFORE INSERT ON transactions FOR EACH ROW EXECUTE FUNCTION ${fn}()`);
      try {
        const before = (await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [budgetId])).rows[0].n;
        const b = [await balances(A.cash), await balances(A.itau)];
        const r = await create({ outflow: 7777770 });
        expect(r.res.status).toBeGreaterThanOrEqual(400);
        const after = (await pool!.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [budgetId])).rows[0].n;
        expect(after).toBe(before);
        expect([await balances(A.cash), await balances(A.itau)]).toEqual(b);
        await expectLedgerConsistent(all);
      } finally {
        await pool!.query(`DROP TRIGGER ${fn} ON transactions`);
        await pool!.query(`DROP FUNCTION ${fn}()`);
      }
    });
  });
}

describe.skipIf(!dbReady)('transfers: old-client deltas never double-apply', () => {
  test('a client that sends its own-account deltas and one that sends none end with identical balances', async () => {
    const [c, n] = [lanes.client, lanes.none];
    // Same sequence in both lanes was already run above; here compare the end state directly.
    for (const l of [c, n]) {
      const res = await send('POST', '/transactions', {
        budget_id: budgetId,
        txn: {
          account_id: l.cash, date: '2025-07-02', payee: `Transfer : ${l.names.itau}`, category_id: null, memo: '',
          outflow: 42420, inflow: 0, cleared: 'uncleared', approved: true, flag: null, repeat: 'never',
        },
        ...(l === c ? { deltas: [{ account_id: l.cash, cleared_delta: 0, uncleared_delta: -4242 }] } : {}),
      });
      expect(res.status).toBe(201);
    }
    expect(await balances(c.cash)).toEqual(await balances(n.cash));
    expect(await balances(c.itau)).toEqual(await balances(n.itau));
    expect(await balances(n.itau)).toEqual([0, 42420]);
    await expectLedgerConsistent([c.cash, c.itau, n.cash, n.itau]);
  });
});
