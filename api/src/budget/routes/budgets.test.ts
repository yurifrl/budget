/**
 * Tests for server/budget/routes/budgets.ts — POST /budgets/fresh-start.
 *
 * Route exercised IN-PROCESS via app.request() with a stubbed identity, the
 * same pattern as budget-restore.test.ts. DB tests are gated on Postgres
 * reachability + migrated schema so `bun test` stays green without a live
 * DB; the test budgets are deleted in afterAll and cascade.
 */

import { afterAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import type { Pool } from 'pg';

import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';

// Static import of ../core/db cannot work: it throws at module load when
// DATABASE_URL is unset, so it is loaded dynamically inside try/catch to
// keep `bun test` green for DB-less environments (budget-restore.test.ts
// pattern). The route module follows it only because its import graph pulls
// db in transitively.
let pool: Pool | null = null;
let dbReady = false;

try {
  const db = await import('../../core/db');
  pool = db.pool;
  await pool.query('SELECT 1');
  const schema = await pool.query<{ t: string | null }>(
    "select to_regclass('public.budgets')::text as t",
  );
  dbReady = schema.rows[0]?.t != null;
} catch {
  pool = null;
  dbReady = false;
}

const routeApp = (await import('./budgets')).default;
const accountsApp = (await import('./accounts')).default;
const transactionsApp = (await import('./transactions')).default;
const repeatRulesApp = (await import('./repeat-rules')).default;
const groupsApp = (await import('./groups')).default;
const categoriesApp = (await import('./categories')).default;
const assignmentsApp = (await import('./assignments')).default;
const payeesApp = (await import('./payees')).default;
const app = new Hono();
app.onError(httpOnError);

const testUserId = crypto.randomUUID();
const testUser: IdentityUser = {
  id: testUserId,
  email: 'budgets-test@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};
app.use('*', (c, next) => {
  c.set('user', testUser);
  return next();
});
app.route('/budgets', routeApp);
app.route('/accounts', accountsApp);
app.route('/transactions', transactionsApp);
app.route('/repeat-rules', repeatRulesApp);
app.route('/groups', groupsApp);
app.route('/categories', categoriesApp);
app.route('/assignments', assignmentsApp);
app.route('/payees', payeesApp);
app.route('/month-notes', (await import('./month-notes')).default);
app.route('/category-notes', (await import('./category-notes')).default);
app.route('/category-targets', (await import('./category-targets')).default);

const createdIds: string[] = [];
const afterAllUsers: string[] = [];

afterAll(async () => {
  if (!dbReady || !pool) return;
  for (const id of createdIds) {
    await pool.query('DELETE FROM public.budgets WHERE id = $1', [id]);
  }
  await pool.query('DELETE FROM public.users WHERE id = ANY($1)', [[testUserId, ...afterAllUsers]]);
});

// DB-backed cases only run when the schema is reachable; skipped otherwise.
const describeIfDb = dbReady ? describe : describe.skip;

let alreadyArchivedId = '';

describeIfDb('POST /budgets/fresh-start', () => {
  test('archives the current budget with a timestamped name and creates the replacement', async () => {
    // The budget owner FK targets public.users; a real row makes
    // POST / (which stamps owner_user_id) succeed instead of 500-ing.
    await pool!.query(
      'INSERT INTO public.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [testUserId, testUser.email],
    );
    const created = await app.request('/budgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Casa Fresh' }),
    });
    expect(created.status).toBe(200);
    const original = (await created.json()) as { id: string; name: string };
    createdIds.push(original.id);

    const res = await app.request('/budgets/fresh-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: original.id }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      archived: { id: string; name: string; archived_at: string | null };
      created: { id: string; name: string; archived_at: string | null };
    };
    createdIds.push(body.created.id);

    // Old budget: renamed with the timestamp suffix, marked archived.
    expect(body.archived.id).toBe(original.id);
    expect(body.archived.name).toMatch(/^Casa Fresh \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    expect(body.archived.archived_at).not.toBeNull();
    // New budget: keeps the original name, active, owned by the requester.
    expect(body.created.name).toBe('Casa Fresh');
    expect(body.created.archived_at).toBeNull();
    expect(body.created.id).not.toBe(original.id);

    // Starter group seeded for the replacement (New Budget parity).
    const groups = await pool!.query(
      'SELECT name FROM public.category_groups WHERE budget_id = $1',
      [body.created.id],
    );
    expect(groups.rows.map((r) => r.name)).toContain('Geral');

    // Old budget keeps its original group — the archive retains data.
    const oldGroups = await pool!.query(
      'SELECT count(*)::int AS n FROM public.category_groups WHERE budget_id = $1',
      [original.id],
    );
    expect(oldGroups.rows[0].n).toBeGreaterThan(0);

    // List exposes archived_at so the switcher can render the archive moment.
    const list = await app.request('/budgets');
    expect(list.status).toBe(200);
    const budgets = (await list.json()) as Array<{
      id: string;
      name: string;
      archived_at: string | null;
    }>;
    const archived = budgets.find((b) => b.id === original.id);
    const fresh = budgets.find((b) => b.id === body.created.id);
    expect(archived?.archived_at).not.toBeNull();
    expect(fresh?.archived_at).toBeNull();
    expect(fresh?.name).toBe('Casa Fresh');
    expect(archived?.name).toMatch(/^Casa Fresh \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
    alreadyArchivedId = original.id;
  });

  test('fresh-start carries accounts.user_id (member assignment survives)', async () => {
    const memberId = crypto.randomUUID();
    await pool!.query(
      'INSERT INTO public.users (id, email) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
      [testUserId, testUser.email],
    );
    await pool!.query('INSERT INTO public.users (id, email) VALUES ($1, $2)', [memberId, 'budgets-person@syscd.local']);
    try {
      const created = await app.request('/budgets', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Person Carry' }),
      });
      const original = (await created.json()) as { id: string };
      createdIds.push(original.id);
      await pool!.query('INSERT INTO public.budget_members (budget_id, user_id) VALUES ($1, $2)', [original.id, memberId]);
      await pool!.query(
        `INSERT INTO accounts (budget_id, name, type, account_group, user_id)
         VALUES ($1, 'Ana Card', 'checking', 'CASH', $2), ($1, 'Joint', 'checking', 'CASH', NULL)`,
        [original.id, memberId],
      );
      const grp = await pool!.query<{ id: string }>(
        `INSERT INTO category_groups (budget_id, name) VALUES ($1, 'PG') RETURNING id`,
        [original.id],
      );
      await pool!.query(
        `INSERT INTO categories (budget_id, group_id, name, user_id)
         VALUES ($1, $2, 'Ana Cat', $3), ($1, $2, 'Joint Cat', NULL)`,
        [original.id, grp.rows[0].id, memberId],
      );
      const res = await app.request('/budgets/fresh-start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ budget_id: original.id }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { created: { id: string } };
      createdIds.push(body.created.id);
      const rows = await pool!.query<{ name: string; user_id: string | null }>(
        'SELECT name, user_id FROM accounts WHERE budget_id = $1 ORDER BY name',
        [body.created.id],
      );
      expect(rows.rows).toEqual([
        { name: 'Ana Card', user_id: memberId },
        { name: 'Joint', user_id: null },
      ]);
      const cats = await pool!.query<{ name: string; user_id: string | null }>(
        `SELECT name, user_id FROM categories WHERE budget_id = $1 AND name IN ('Ana Cat', 'Joint Cat') ORDER BY name`,
        [body.created.id],
      );
      expect(cats.rows).toEqual([
        { name: 'Ana Cat', user_id: memberId },
        { name: 'Joint Cat', user_id: null },
      ]);
    } finally {
      // Budgets are cleaned in afterAll; the member user must go after them.
      afterAllUsers.push(memberId);
    }
  });

  test('cross-owner budget surfaces as 404, never 403', async () => {
    const res = await app.request('/budgets/fresh-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: crypto.randomUUID() }),
    });
    expect(res.status).toBe(404);
  });

  test('fresh-start on an already-archived budget is a 409', async () => {
    const res = await app.request('/budgets/fresh-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: alreadyArchivedId }),
    });
    expect(res.status).toBe(409);
  });

  test('malformed budget_id is a 400', async () => {
    const res = await app.request('/budgets/fresh-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: 'not-a-uuid' }),
    });
    expect(res.status).toBe(400);
  });

  // ---- carry-over + reset coverage (AUTHORED-06 YNAB parity) --------------
  test('carries accounts, linked history/balances, schedule, plan structure; resets plan data', async () => {
    const seed = await app.request('/budgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Carryover Probe' }),
    });
    expect(seed.status).toBe(200);
    const budget = (await seed.json()) as { id: string };
    createdIds.push(budget.id);
    const bid = budget.id;

    // Seed accounts via the real route: linked one mirrors an imported bank
    // account (history + balances), the unlinked one has none.
    const linked = await app.request(`/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, name: 'Nubank Linked', type: 'checking', on_budget: true, balance: 0 }),
    });
    expect(linked.status).toBe(201);
    const linkedAcc = (await linked.json()) as { id: string };

    const unlinked = await app.request(`/accounts`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, name: 'Carteira', type: 'checking', on_budget: true, balance: 0 }),
    });
    expect(unlinked.status).toBe(201);
    const unlinkedAcc = (await unlinked.json()) as { id: string };

    // Linked: history through today (one cleared import + one uncleared
    // manual edit today) and one future-dated entered row that must NOT carry.
    const hist = await app.request(`/transactions/bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: bid,
        account_id: linkedAcc.id,
        txns: [
          {
            date: '2026-01-05',
            payee: 'Padaria',
            category_id: null,
            memo: '',
            outflow: 50000,
            inflow: 0,
            cleared: 'cleared',
            approved: true,
            flag: null,
            import_id: 'seed-import-1',
          },
          {
            date: '2026-01-06',
            payee: 'Mercado',
            category_id: null,
            memo: '',
            outflow: 120000,
            inflow: 0,
            cleared: 'uncleared',
            approved: true,
            flag: null,
          },
        ],
      }),
    });
    expect(hist.status).toBe(201);

    // Manual edit today: books −9000 cents to the uncleared bucket via the
    // client-supplied delta (cents; the route multiplies by 10).
    const manual = await app.request(`/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: bid,
        txn: {
          account_id: linkedAcc.id,
          date: '2026-10-24',
          payee: 'Mesa Bar',
          category_id: null,
          memo: '',
          outflow: 90000,
          inflow: 0,
          cleared: 'uncleared',
          approved: true,
          flag: null,
          repeat: '',
        },
      }),
    });
    expect(manual.status).toBe(201);

    // Future-dated entry, dated beyond the carry-through-today cutoff so
    // fresh-start must NOT copy it.
    const future = await app.request(`/transactions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: bid,
        txn: {
          account_id: linkedAcc.id,
          date: '2099-02-01',
          payee: 'Assinatura',
          category_id: null,
          memo: '',
          outflow: 90000,
          inflow: 0,
          cleared: 'uncleared',
          approved: true,
          flag: null,
          repeat: '',
        },
      }),
    });
    expect(future.status).toBe(201);

    // Mark the linked account as import-linked (no live connection needed —
    // carry-over keys off the flag, not the connection row).
    await pool!.query('UPDATE public.accounts SET direct_import_linked = true WHERE id = $1', [
      linkedAcc.id,
    ]);

    // Repeat rule on the UNLINKED account — rules carry regardless of linkage.
    const rule = await app.request(`/repeat-rules`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        budget_id: bid,
        account_id: unlinkedAcc.id,
        payee: 'Aluguel',
        category_id: null,
        memo: null,
        outflow: 1500000,
        inflow: 0,
        frequency: 'monthly',
        month_last_day: false,
        next_due_date: '2026-11-10',
      }),
    });
    expect(rule.status).toBe(201);
    const ruleBody = (await rule.json()) as { id: string };

    // Materialize upcoming occurrences for the rule.
    const gen = await app.request(`/repeat-rules/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid }),
    });
    expect(gen.status).toBe(200);

    // Plan structure: a second group, category with goal + note + target, a
    // payee with default_category_id, rename rule, month notes, assignments.
    const grp = await app.request(`/groups`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, name: 'Fixas' }),
    });
    expect([200, 201]).toContain(grp.status);
    const grpBody = (await grp.json()) as { id: string };

    const cat = await app.request(`/categories`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, group_id: grpBody.id, name: 'Aluguel', sort_order: 0 }),
    });
    expect([200, 201]).toContain(cat.status);
    const catBody = (await cat.json()) as { id: string };

    await pool!.query(`UPDATE public.categories SET goal_type = 'NEED', goal_target = 150000, note = 'goal note' WHERE id = $1`, [
      catBody.id,
    ]);
    await pool!.query(
      "INSERT INTO public.category_targets (budget_id, category_id, kind, amount_cents, config) VALUES ($1, $2, 'monthly', 150000, '{}')",
      [bid, catBody.id],
    );
    await pool!.query('INSERT INTO public.category_notes (budget_id, category_id, month, note) VALUES ($1, $2, $3, $4)', [
      bid,
      catBody.id,
      '2026-01-01',
      'cat note',
    ]);
    await pool!.query('INSERT INTO public.month_notes (budget_id, month, note) VALUES ($1, $2, $3)', [
      bid,
      '2026-01-01',
      'month note',
    ]);
    const asg = await app.request(`/assignments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, month: '2026-01-01', category_id: catBody.id, budgeted: 150000 }),
    });
    expect([200, 201]).toContain(asg.status);

    const payee = await app.request(`/payees`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid, name: 'Aluguel' }),
    });
    expect([200, 201]).toContain(payee.status);
    const payeeBody = (await payee.json()) as { id: string };
    await pool!.query('UPDATE public.payees SET default_category_id = $2 WHERE id = $1', [
      payeeBody.id,
      catBody.id,
    ]);
    const rr = await app.request(`/payees/${payeeBody.id}/rename-rule?budget_id=${bid}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ match_type: 'is', condition: 'NU PAG' }),
    });
    expect([200, 204]).toContain(rr.status);

    const res = await app.request('/budgets/fresh-start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ budget_id: bid }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { archived: { id: string }; created: { id: string } };
    createdIds.push(body.created.id);
    const nid = body.created.id;

    // Accounts: both carry; linked keeps balances/history linkage, unlinked
    // resets to zero.
    const accs = await pool!.query<{ id: string; name: string; direct_import_linked: boolean; cleared_balance: string; uncleared_balance: string }>(
      'SELECT id, name, direct_import_linked, cleared_balance, uncleared_balance FROM public.accounts WHERE budget_id = $1 ORDER BY name',
      [nid],
    );
    expect(accs.rows).toHaveLength(2);
    const newLinked = accs.rows.find((a) => a.name === 'Nubank Linked')!;
    const newUnlinked = accs.rows.find((a) => a.name === 'Carteira')!;
    expect(newLinked.direct_import_linked).toBe(true);
    expect(newUnlinked.direct_import_linked).toBe(false);
    // Balances were seeded to 0; the linked account then booked −5000 (cleared
    // import) −12000 (uncleared import) −9000 (manual edit) cents, all into
    // the uncleared bucket (bulk routes every row there), plus the −9000 future-dated
    // entry: balances are always server-derived (G13), so it now counts too.
    // The copied balance arrives verbatim.
    expect(Number(newLinked.uncleared_balance)).toBe(-350000);
    expect(Number(newUnlinked.uncleared_balance)).toBe(0);

    // Linked history carried through today; future-dated entered row did not.
    const txns = await pool!.query<{ payee_id: string | null; date: string }>(
      `SELECT t.date::text AS date FROM public.transactions t
         JOIN public.accounts a ON a.id = t.account_id
        WHERE a.budget_id = $1 AND t.deleted = false AND t.upcoming = false`,
      [nid],
    );
    const dates = txns.rows.map((r) => r.date);
    expect(dates).toContain('2026-01-05');
    expect(dates).toContain('2026-01-06');
    expect(dates).not.toContain('2099-02-01');

    // Repeat rules + upcoming occurrences carried (rule on unlinked account).
    const rules = await pool!.query<{ id: string }>(
      'SELECT id FROM public.txn_repeat_rules WHERE budget_id = $1 AND NOT deleted',
      [nid],
    );
    expect(rules.rows[0]?.id).toBeTruthy();
    const upcoming = await pool!.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.transactions t
         JOIN public.accounts a ON a.id = t.account_id
        WHERE a.budget_id = $1 AND t.upcoming = true AND NOT t.deleted`,
      [nid],
    );
    expect(upcoming.rows[0].n).toBeGreaterThan(0);

    // Plan structure carried: groups, categories (+goal/note), targets.
    const cats = await pool!.query<{ name: string; note: string | null; goal_type: string | null }>(
      'SELECT name, note, goal_type FROM public.categories WHERE budget_id = $1 AND NOT deleted',
      [nid],
    );
    expect(cats.rows.map((r) => r.name)).toContain('Aluguel');
    const aluguel = cats.rows.find((r) => r.name === 'Aluguel')!;
    expect(aluguel.note).toBe('goal note');
    expect(aluguel.goal_type).toBe('NEED');

    const targets = await pool!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.category_targets WHERE budget_id = $1',
      [nid],
    );
    expect(targets.rows[0].n).toBe(1);

    const groups = await pool!.query<{ name: string }>(
      'SELECT name FROM public.category_groups WHERE budget_id = $1 AND NOT deleted',
      [nid],
    );
    expect(groups.rows.map((r) => r.name)).toContain('Fixas');

    // Category notes carried; month notes reset.
    const catNotes = await pool!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.category_notes WHERE budget_id = $1',
      [nid],
    );
    expect(catNotes.rows[0].n).toBe(1);
    const monthNotes = await pool!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.month_notes WHERE budget_id = $1',
      [nid],
    );
    expect(monthNotes.rows[0].n).toBe(0);

    // Payees carried with remapped default_category_id; rename rules carried
    // (rules live on the payee row itself, not the legacy rename table).
    const payees = await pool!.query<{ default_category_id: string | null; rename_match_type: string | null }>(
      "SELECT default_category_id, rename_match_type FROM public.payees WHERE budget_id = $1 AND name = 'Aluguel' AND NOT deleted",
      [nid],
    );
    const newCat = await pool!.query<{ id: string }>(
      "SELECT id FROM public.categories WHERE budget_id = $1 AND name = 'Aluguel' AND NOT deleted",
      [nid],
    );
    expect(payees.rows[0].default_category_id).toBe(newCat.rows[0]?.id);
    expect(payees.rows[0].rename_match_type).toBe('is');

    // Assignments reset — the fresh plan starts unbudgeted.
    const assigns = await pool!.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM public.assignments WHERE budget_id = $1',
      [nid],
    );
    expect(assigns.rows[0].n).toBe(0);

    // Ids really are new rows (not shared with the archive).
    const freshTxnIds = await pool!.query<{ id: string }>(
      'SELECT t.id FROM public.transactions t JOIN public.accounts a ON a.id = t.account_id WHERE a.budget_id = $1',
      [nid],
    );
    const oldTxnIds = await pool!.query<{ id: string }>(
      'SELECT t.id FROM public.transactions t JOIN public.accounts a ON a.id = t.account_id WHERE a.budget_id = $1',
      [bid],
    );
    const oldSet = new Set(oldTxnIds.rows.map((r) => r.id));
    expect(freshTxnIds.rows.every((r) => !oldSet.has(r.id))).toBe(true);
  });
});

describeIfDb('POST /budgets/:id/archive + /unarchive', () => {
  test('archive stamps archived_at, is idempotent, unarchive clears it; cross-owner is 404', async () => {
    const created = await app.request('/budgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Archive Test' }),
    });
    expect(created.status).toBe(200);
    const budget = (await created.json()) as { id: string };
    createdIds.push(budget.id);

    const res = await app.request(`/budgets/${budget.id}/archive`, { method: 'POST' });
    expect(res.status).toBe(200);
    const archived = (await res.json()) as { id: string; archived_at: string | null };
    expect(archived.id).toBe(budget.id);
    expect(archived.archived_at).not.toBeNull();

    // Archive again — idempotent, same row back.
    const again = await app.request(`/budgets/${budget.id}/archive`, { method: 'POST' });
    expect(again.status).toBe(200);
    const same = (await again.json()) as { id: string };
    expect(same.id).toBe(budget.id);

    // Unarchive — back to active.
    const un = await app.request(`/budgets/${budget.id}/unarchive`, { method: 'POST' });
    expect(un.status).toBe(200);
    const unarchived = (await un.json()) as { id: string; archived_at: string | null };
    expect(unarchived.id).toBe(budget.id);
    expect(unarchived.archived_at).toBeNull();

    // Unarchive an active budget — idempotent too.
    const again2 = await app.request(`/budgets/${budget.id}/unarchive`, { method: 'POST' });
    expect(again2.status).toBe(200);

    // Cross-owner archive surfaces as 404.
    const stranger = await app.request(`/budgets/${crypto.randomUUID()}/archive`, {
      method: 'POST',
    });
    expect(stranger.status).toBe(404);
  });
});

describeIfDb('DELETE /budgets/:id', () => {
  test('deletes the budget and every row under it; repeat is a 404', async () => {
    const created = await app.request('/budgets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Delete Test' }),
    });
    expect(created.status).toBe(200);
    const budget = (await created.json()) as { id: string };

    // Seed a group under the budget — it must cascade away with the budget.
    const grp = await pool!.query<{ id: string }>(
      'INSERT INTO public.category_groups (id, budget_id, name) VALUES ($1, $2, $3) RETURNING id',
      [crypto.randomUUID(), budget.id, 'Geral'],
    );
    expect(grp.rows.length).toBe(1);

    const res = await app.request(`/budgets/${budget.id}`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deleted: boolean };
    expect(body.deleted).toBe(true);

    const gone = await pool!.query<{ id: string }>(
      'SELECT id FROM public.budgets WHERE id = $1',
      [budget.id],
    );
    expect(gone.rows.length).toBe(0);
    const groupGone = await pool!.query<{ id: string }>(
      'SELECT id FROM public.category_groups WHERE id = $1',
      [grp.rows[0].id],
    );
    expect(groupGone.rows.length).toBe(0);

    // Second delete — budget no longer exists → 404.
    const repeat = await app.request(`/budgets/${budget.id}`, { method: 'DELETE' });
    expect(repeat.status).toBe(404);
  });
});
