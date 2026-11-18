/**
 * Catalog-level access test (G14). `budgetAccess` only authorises the
 * `budget_id` a request carries in its query or body; `/:id` routes re-scope
 * in SQL by convention. This test drives every budget/connections operation
 * that has a path parameter, straight from the contract catalog, as a user
 * who is NOT a member of the budget (or owner of the connection) the row
 * belongs to:
 *
 * A. operations with a path param and no `budget_id` input (budgets/:id,
 *    connections/:id): must answer 404;
 * B. operations with a path param AND a `budget_id`: the attacker sends their
 *    OWN budget_id (which budgetAccess accepts) with the victim's row id: 404,
 *    the victim's budget byte-for-byte unchanged, no victim data in the
 *    response, and no row of the attacker's budget pointing at a victim row.
 *
 * A new path-param operation fails the coverage test until it gets a sample
 * input here (or an allow-list entry with a reason).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts as budgetContracts } from '@shared/contracts/budget';
import { contracts as connectionsContracts } from '@shared/contracts/connections';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import budget from './budget';
import connections from './connections';
import { pool } from './core/db';
import { dbReady } from './core/test-gate';
import { httpOnError } from './core/validate';
import type { IdentityUser } from './user';

const mkUser = (tag: string): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `access-${tag}@accesscatalog.test`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const victim = mkUser('victim');
const attacker = mkUser('attacker');

// Victim fixtures (ids fixed up front so samples can reference them).
const V = {
  budget: crypto.randomUUID(),
  account: crypto.randomUUID(),
  group: crypto.randomUUID(),
  category: crypto.randomUUID(),
  bundle: crypto.randomUUID(),
  payee: crypto.randomUUID(),
  txn: crypto.randomUUID(),
  rule: crypto.randomUUID(),
  connection: crypto.randomUUID(),
};
// Attacker's own budget (budgetAccess lets them address it).
const A = {
  budget: crypto.randomUUID(),
  account: crypto.randomUUID(),
  payee: crypto.randomUUID(),
  txn: crypto.randomUUID(),
};
const VICTIM_MARKER = 'VictimSecretPayee';

const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', attacker);
  return next();
});
app.route('/', budget);
app.route('/connections', connections);

/** Sample inputs (victim row ids; attacker's budget id) per path-param operation. */
const samples: Record<string, Record<string, unknown>> = {
  // A: no budget_id
  budget_archive: { id: V.budget },
  budget_unarchive: { id: V.budget },
  budget_rename: { id: V.budget, name: 'pwned' },
  budget_delete: { id: V.budget },
  connections_get: { id: V.connection },
  connections_delete: { id: V.connection },
  connections_reimport: { id: V.connection },
  connections_sync: { id: V.connection },
  connections_settings_update_one: { id: V.connection, syncWindowDays: null },
  connections_accounts_summary: { id: V.connection },
  connections_transactions_list: { id: V.connection, accountId: V.account },
  // B: path id of a victim row + the attacker's own budget_id
  budget_accounts_delete: { id: V.account, budget_id: A.budget },
  budget_accounts_reconcile: { id: V.account, budget_id: A.budget, stated_balance_cents: 0 },
  budget_accounts_update: { id: V.account, budget_id: A.budget, name: 'pwned' },
  budget_categories_delete: { id: V.category, budget_id: A.budget },
  budget_categories_rename: { id: V.category, budget_id: A.budget, name: 'pwned' },
  budget_categories_set_hidden: { id: V.category, budget_id: A.budget, hidden: true },
  budget_categories_set_notes: { id: V.category, budget_id: A.budget, notes: 'pwned' },
  budget_categories_set_person: { id: V.category, budget_id: A.budget, user_id: null },
  budget_categories_set_target: { id: V.category, budget_id: A.budget, target: { amount_cents: 100 } },
  budget_bundles_delete: { id: V.bundle, budget_id: A.budget },
  budget_bundles_rename: { id: V.bundle, budget_id: A.budget, name: 'pwned' },
  budget_category_notes_set: { categoryId: V.category, budget_id: A.budget, month: '2026-01-01', note: 'pwned' },
  budget_category_targets_delete: { categoryId: V.category, budget_id: A.budget },
  budget_category_targets_set: {
    categoryId: V.category,
    budget_id: A.budget,
    kind: 'monthly',
    amount_cents: 100,
    snooze_month: null,
  },
  budget_groups_delete: { id: V.group, budget_id: A.budget },
  budget_groups_rename: { id: V.group, budget_id: A.budget, name: 'pwned' },
  budget_payee_suggestions_get: { id: V.payee, budget_id: A.budget },
  budget_payees_delete: { id: V.payee, budget_id: A.budget },
  budget_payees_merge: { id: A.payee, budget_id: A.budget, target_id: V.payee },
  budget_payees_rename: { id: V.payee, budget_id: A.budget, name: 'pwned' },
  budget_payees_set_categorization: {
    id: V.payee,
    budget_id: A.budget,
    categorization_mode: 'fixed',
    default_category_id: null,
  },
  budget_payees_set_hidden: { id: V.payee, budget_id: A.budget, hidden: true },
  budget_payees_set_rename_rule: { id: V.payee, budget_id: A.budget, match_type: 'is', condition: 'pwned' },
  budget_payees_transactions: { id: V.payee, budget_id: A.budget },
  budget_repeat_rules_delete: { id: V.rule, budget_id: A.budget },
  budget_transactions_delete: { id: V.txn, budget_id: A.budget },
  budget_transactions_update: { id: V.txn, budget_id: A.budget, patch: { memo: 'pwned' } },
};

/** Path-param operations that are legitimately not budget/connection-scoped (none today). */
const notScoped: Record<string, string> = {};

const pathOps = [...budgetContracts, ...connectionsContracts].filter(
  (c) => c.expose.api && inputLocations(c).path.length > 0 && !(c.name in notScoped),
);
const hasBudgetId = (c: OperationContract) => 'budget_id' in c.input.shape;

function buildRequest(contract: OperationContract, input: Record<string, unknown>): Request {
  const loc = inputLocations(contract);
  let path = contract.path;
  for (const p of loc.path) path = path.replace(`:${p}`, encodeURIComponent(String(input[p])));
  const qs = new URLSearchParams();
  for (const q of loc.query) if (input[q] !== undefined && input[q] !== null) qs.set(q, String(input[q]));
  let body: unknown;
  if (contract.bodyKey) body = input[contract.bodyKey];
  else if (loc.body.length > 0) body = Object.fromEntries(loc.body.filter((k) => k in input).map((k) => [k, input[k]]));
  const url = `http://test${path}${qs.size ? `?${qs}` : ''}`;
  return new Request(url, {
    method: contract.method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined || contract.method === 'GET' ? undefined : JSON.stringify(body),
  });
}

/** Every victim-budget row, as JSON, table by table (the "unchanged" oracle). */
async function victimSnapshot(): Promise<string> {
  const tables = [
    'budgets', 'accounts', 'category_groups', 'categories', 'category_bundles', 'payees', 'transactions',
    'subtransactions', 'txn_repeat_rules', 'category_targets', 'category_notes', 'budget_members',
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    const col = t === 'budgets' ? 'id' : 'budget_id';
    out[t] = (await pool.query(`SELECT to_jsonb(x) AS j FROM public.${t} x WHERE ${col} = $1 ORDER BY to_jsonb(x)::text`, [V.budget])).rows;
  }
  out.connection = (await pool.query('SELECT to_jsonb(c) AS j FROM public.connections c WHERE id = $1', [V.connection])).rows;
  return JSON.stringify(out);
}

/** Attacker-budget rows that reference a victim row (cross-budget pointers). */
async function crossReferences(): Promise<string[]> {
  const r = await pool.query<{ what: string }>(
    `SELECT 'transactions.' || col AS what FROM (
       SELECT unnest(ARRAY['payee_id','category_id','account_id','transfer_account_id','transfer_transaction_id']) AS col
     ) cols
     WHERE EXISTS (
       SELECT 1 FROM transactions t
        WHERE t.budget_id = $1
          AND (CASE col WHEN 'payee_id' THEN t.payee_id WHEN 'category_id' THEN t.category_id
                        WHEN 'account_id' THEN t.account_id WHEN 'transfer_account_id' THEN t.transfer_account_id
                        ELSE t.transfer_transaction_id END)
              IN (SELECT id FROM payees WHERE budget_id = $2 UNION SELECT id FROM categories WHERE budget_id = $2
                  UNION SELECT id FROM accounts WHERE budget_id = $2 UNION SELECT id FROM transactions WHERE budget_id = $2))
     UNION ALL
     SELECT 'category_notes.category_id' FROM category_notes n
      WHERE n.budget_id = $1 AND n.category_id IN (SELECT id FROM categories WHERE budget_id = $2)
     UNION ALL
     SELECT 'category_targets.category_id' FROM category_targets ct
      WHERE ct.budget_id = $1 AND ct.category_id IN (SELECT id FROM categories WHERE budget_id = $2)`,
    [A.budget, V.budget],
  );
  return r.rows.map((x) => x.what);
}

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[V.budget, A.budget]]);
  await pool.query('DELETE FROM public.connections WHERE id = $1', [V.connection]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE 'access-%@accesscatalog.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  for (const u of [victim, attacker]) {
    await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [u.id, u.email]);
  }
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'access-victim', $2), ($3, 'access-attacker', $4)`, [
    V.budget, victim.id, A.budget, attacker.id,
  ]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2), ($3, $4)`, [V.budget, victim.id, A.budget, attacker.id]);
  await pool.query(
    `INSERT INTO connections (id, user_id, provider, external_id, status) VALUES ($1, $2, 'access-test', $3, 'connected')`,
    [V.connection, victim.id, `access-item-${V.connection}`],
  );
  await pool.query(
    `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget, closed, connection_id, external_account_id)
     VALUES ($1, $2, 'Victim Checking', 'checking', 'CASH', true, true, $3, 'ext-1'),
            ($4, $5, 'Attacker Checking', 'checking', 'CASH', true, false, NULL, NULL)`,
    [V.account, V.budget, V.connection, A.account, A.budget],
  );
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, 'Victim Group', 0)`, [V.group, V.budget]);
  await pool.query(`INSERT INTO categories (id, budget_id, group_id, name, sort_order) VALUES ($1, $2, $3, 'Victim Cat', 0)`, [
    V.category, V.budget, V.group,
  ]);
  await pool.query(`INSERT INTO category_bundles (id, budget_id, group_id, name) VALUES ($1, $2, $3, 'Victim Bundle')`, [
    V.bundle, V.budget, V.group,
  ]);
  await pool.query(`INSERT INTO payees (id, budget_id, name) VALUES ($1, $2, $3), ($4, $5, 'Attacker Payee')`, [
    V.payee, V.budget, VICTIM_MARKER, A.payee, A.budget,
  ]);
  await pool.query(
    `INSERT INTO transactions (id, budget_id, account_id, date, amount, payee_id, category_id, memo, cleared, approved, repeat, deleted)
     VALUES ($1, $2, $3, '2026-01-05', -1000, $4, $5, 'victim memo', 'uncleared', true, 'never', false),
            ($6, $7, $8, '2026-01-05', -500, $9, NULL, NULL, 'uncleared', true, 'never', false)`,
    [V.txn, V.budget, V.account, V.payee, V.category, A.txn, A.budget, A.account, A.payee],
  );
  await pool.query(
    `INSERT INTO txn_repeat_rules (id, budget_id, account_id, payee_id, amount, frequency, next_due_date)
     VALUES ($1, $2, $3, $4, -1000, 'monthly', '2027-01-01')`,
    [V.rule, V.budget, V.account, V.payee],
  );
  await pool.query(
    `INSERT INTO category_targets (budget_id, category_id, kind, amount_cents) VALUES ($1, $2, 'monthly', 500)`,
    [V.budget, V.category],
  );
});

afterAll(async () => {
  if (dbReady) await cleanup();
});

describe('access catalog coverage', () => {
  test('every path-param budget/connections operation has a sample input', () => {
    const missing = pathOps.map((c) => c.name).filter((n) => !(n in samples));
    expect(missing).toEqual([]);
  });

  test('every sample parses against its contract input', () => {
    for (const c of pathOps) {
      const parsed = c.input.safeParse(samples[c.name]);
      expect(parsed.success ? 'ok' : JSON.stringify(parsed.error.issues), c.name).toBe('ok');
    }
  });
});

describe.skipIf(!dbReady)('non-member access by path param (G14)', () => {
  for (const c of pathOps.filter((op) => !hasBudgetId(op))) {
    test(`A: ${c.method} ${c.path} (${c.name}) is 404 for a non-owner`, async () => {
      const before = await victimSnapshot();
      const res = await app.request(buildRequest(c, samples[c.name]!));
      expect(res.status, c.name).toBe(404);
      expect(await victimSnapshot(), c.name).toBe(before);
    });
  }

  for (const c of pathOps.filter(hasBudgetId)) {
    test(`B: ${c.method} ${c.path} (${c.name}) with the attacker's own budget_id cannot touch or read the victim's row`, async () => {
      const before = await victimSnapshot();
      const res = await app.request(buildRequest(c, samples[c.name]!));
      const text = await res.text();
      expect(res.status, `${c.name}: ${text}`).toBe(404);
      expect(await victimSnapshot(), `${c.name}: victim budget changed (status ${res.status})`).toBe(before);
      expect(text.includes(VICTIM_MARKER) || text.includes(V.txn), `${c.name}: response leaks victim data`).toBe(false);
      expect(await crossReferences(), `${c.name}: attacker rows now point at victim rows`).toEqual([]);
    });
  }
});
