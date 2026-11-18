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
 *
 * C. row ids carried in the BODY or query (group_id, category_id, account_id,
 *    moves[].group_id, updates[].category_id, user_id, ...): found from the
 *    contract input schemas (every uuid-typed field that is not a path param
 *    or budget_id). Each is exercised as a member of budget A supplying an id
 *    that belongs to budget B; nothing in B may be read or changed, and no row
 *    of A may end up referencing a row of B. A new id-carrying field fails the
 *    coverage test until it has a case here (or an allow-list entry).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts as budgetContracts } from '@shared/contracts/budget';
import { contracts as connectionsContracts } from '@shared/contracts/connections';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import { UUID_RE } from '@shared/validation';
import { z } from '@shared/zod';
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
  /** A third budget the attacker owns, only for budget_restore (it wipes its budget). */
  restoreBudget: crypto.randomUUID(),
  account: crypto.randomUUID(),
  group: crypto.randomUUID(),
  category: crypto.randomUUID(),
  category2: crypto.randomUUID(),
  bundle: crypto.randomUUID(),
  payee: crypto.randomUUID(),
  txn: crypto.randomUUID(),
  connection: crypto.randomUUID(),
};
const VICTIM_MARKER = 'VictimSecretPayee';
/** Names of victim rows: none may appear in a response to the attacker. */
const VICTIM_MARKERS = [VICTIM_MARKER, 'Victim Checking', 'Victim Group', 'Victim Cat', 'Victim Bundle', 'victim memo', 'access-victim'];

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
async function budgetSnapshot(budgetId: string, withConnection = false): Promise<string> {
  const tables = [
    'budgets', 'accounts', 'category_groups', 'categories', 'category_bundles', 'payees', 'transactions',
    'subtransactions', 'txn_repeat_rules', 'category_targets', 'category_notes', 'month_notes', 'assignments', 'budget_members',
  ];
  const out: Record<string, unknown> = {};
  for (const t of tables) {
    const col = t === 'budgets' ? 'id' : 'budget_id';
    out[t] = (await pool.query(`SELECT to_jsonb(x) AS j FROM public.${t} x WHERE ${col} = $1 ORDER BY to_jsonb(x)::text`, [budgetId])).rows;
  }
  if (withConnection) {
    out.connection = (await pool.query('SELECT to_jsonb(c) AS j FROM public.connections c WHERE id = $1', [V.connection])).rows;
  }
  return JSON.stringify(out);
}
const victimSnapshot = () => budgetSnapshot(V.budget, true);

/**
 * Every (table, column) pair that points at a budget-scoped row, with the
 * table it points into. An attacker-budget row whose pointer lands on a victim
 * row is a cross-budget reference.
 */
const POINTERS: Array<[table: string, column: string, target: string]> = [
  ['transactions', 'payee_id', 'payees'],
  ['transactions', 'category_id', 'categories'],
  ['transactions', 'account_id', 'accounts'],
  ['transactions', 'transfer_account_id', 'accounts'],
  ['transactions', 'transfer_transaction_id', 'transactions'],
  ['transactions', 'matched_transaction_id', 'transactions'],
  ['subtransactions', 'transaction_id', 'transactions'],
  ['subtransactions', 'category_id', 'categories'],
  ['category_notes', 'category_id', 'categories'],
  ['category_targets', 'category_id', 'categories'],
  ['assignments', 'category_id', 'categories'],
  ['categories', 'group_id', 'category_groups'],
  ['categories', 'bundle_id', 'category_bundles'],
  ['category_bundles', 'group_id', 'category_groups'],
  ['payees', 'default_category_id', 'categories'],
  ['payees', 'transfer_account_id', 'accounts'],
  ['txn_repeat_rules', 'account_id', 'accounts'],
  ['txn_repeat_rules', 'category_id', 'categories'],
  ['txn_repeat_rules', 'payee_id', 'payees'],
];

/** Attacker-budget rows that reference a victim row (cross-budget pointers). */
async function crossReferences(budgetIds: string[] = [A.budget]): Promise<string[]> {
  const found: string[] = [];
  for (const [table, column, target] of POINTERS) {
    const r = await pool.query(
      `SELECT 1 FROM public.${table} x WHERE x.budget_id = ANY($1)
          AND x.${column} IN (SELECT id FROM public.${target} WHERE budget_id = $2) LIMIT 1`,
      [budgetIds, V.budget],
    );
    if ((r.rowCount ?? 0) > 0) found.push(`${table}.${column}`);
  }
  // Person pointers: the attacker's rows may only name members of their own budget.
  for (const table of ['accounts', 'categories']) {
    const r = await pool.query(
      `SELECT 1 FROM public.${table} x WHERE x.budget_id = ANY($1) AND x.user_id = $2 LIMIT 1`,
      [budgetIds, victim.id],
    );
    if ((r.rowCount ?? 0) > 0) found.push(`${table}.user_id`);
  }
  return found;
}

async function cleanup() {
  await pool.query('DELETE FROM public.budgets WHERE id = ANY($1)', [[V.budget, A.budget, A.restoreBudget]]);
  await pool.query('DELETE FROM public.connections WHERE id = ANY($1)', [[V.connection, A.connection]]);
  await pool.query(`DELETE FROM public.users WHERE email LIKE 'access-%@accesscatalog.test'`);
}

beforeAll(async () => {
  if (!dbReady) return;
  await cleanup();
  for (const u of [victim, attacker]) {
    await pool.query(`INSERT INTO public.users (id, email, role) VALUES ($1, $2, 'user')`, [u.id, u.email]);
  }
  await pool.query(`INSERT INTO budgets (id, name, owner_user_id) VALUES ($1, 'access-victim', $2), ($3, 'access-attacker', $4), ($5, 'access-restore', $4)`, [
    V.budget, victim.id, A.budget, attacker.id, A.restoreBudget,
  ]);
  await pool.query(`INSERT INTO budget_members (budget_id, user_id) VALUES ($1, $2), ($3, $4), ($5, $4)`, [
    V.budget, victim.id, A.budget, attacker.id, A.restoreBudget,
  ]);
  await pool.query(
    `INSERT INTO connections (id, user_id, provider, external_id, status) VALUES ($1, $2, 'access-test', $3, 'connected')`,
    [A.connection, attacker.id, `access-item-${A.connection}`],
  );
  await pool.query(`INSERT INTO category_groups (id, budget_id, name, sort_order) VALUES ($1, $2, 'Attacker Group', 0)`, [A.group, A.budget]);
  await pool.query(
    `INSERT INTO categories (id, budget_id, group_id, name, sort_order, bundle_id) VALUES ($1, $2, $3, 'Attacker Cat', 0, NULL), ($4, $2, $3, 'Attacker Cat 2', 1, NULL)`,
    [A.category, A.budget, A.group, A.category2],
  );
  await pool.query(`INSERT INTO category_bundles (id, budget_id, group_id, name) VALUES ($1, $2, $3, 'Attacker Bundle')`, [A.bundle, A.budget, A.group]);
  await pool.query(`UPDATE categories SET bundle_id = $1 WHERE id = $2`, [A.bundle, A.category2]);
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
  await pool.query(`INSERT INTO assignments (budget_id, month, category_id, budgeted) VALUES ($1, '2026-01-01', $2, 1000)`, [V.budget, V.category]);
  await pool.query(`INSERT INTO month_notes (budget_id, month, note) VALUES ($1, '2026-01-01', 'victim month note')`, [V.budget]);
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

// ---- C. ids carried in the body or query ------------------------------------

/** Every uuid-typed input field of a contract (dotted path, `[]` for arrays), minus path params and budget_id. */
function idFields(contract: OperationContract): string[] {
  const out: string[] = [];
  const walk = (node: any, path: string) => {
    if (!node || typeof node !== 'object') return;
    if (node.pattern === UUID_RE.source) out.push(path);
    for (const [k, v] of Object.entries<any>(node.properties ?? {})) walk(v, path ? `${path}.${k}` : k);
    if (node.items) walk(node.items, `${path}[]`);
    for (const key of ['anyOf', 'oneOf', 'allOf']) for (const v of node[key] ?? []) walk(v, path);
  };
  walk(z.toJSONSchema(contract.input, { io: 'input', unrepresentable: 'any' }), '');
  const pathParams = inputLocations(contract).path;
  return [...new Set(out)].filter((p) => p !== 'budget_id' && !pathParams.includes(p));
}

const scopedContracts = [...budgetContracts, ...connectionsContracts].filter((c) => c.expose.api);
const bodyIdFields = scopedContracts.flatMap((c) => idFields(c).map((field) => ({ op: c.name, field })));

/**
 * reject: a member of A naming a B row must get this status (400 or 404, the
 *   neighbours' choice) and nothing is written anywhere.
 * ignored: the field is accepted but never stored (the request may succeed);
 *   only the no-read / no-write / no-pointer invariants are asserted.
 * sanitised: accepted, but the foreign person is replaced by Shared (null).
 */
type Outcome = 'reject' | 'ignored' | 'sanitised';
interface BodyCase {
  op: string;
  /** The id field(s) of the contract this case exercises (dotted path). */
  fields: string[];
  outcome: Outcome;
  /** Exact status for `reject` (default 404). */
  status?: 400 | 404 | 409;
  input: Record<string, unknown>;
}

const MONTH = '2026-01-01';
const txnBase = (extra: Record<string, unknown> = {}) => ({
  account_id: A.account,
  date: '2026-02-01',
  payee: 'Some Payee',
  category_id: null,
  memo: null,
  outflow_cents: 100,
  inflow_cents: 0,
  cleared: 'uncleared',
  approved: true,
  flag: null,
  repeat: 'never',
  ...extra,
});
const ruleBase = (extra: Record<string, unknown> = {}) => ({
  budget_id: A.budget,
  account_id: A.account,
  payee: 'p',
  category_id: null,
  memo: '',
  outflow_cents: 100,
  inflow_cents: 0,
  frequency: 'monthly',
  month_last_day: false,
  next_due_date: '2027-01-01',
  ...extra,
});
const bulkRow = (extra: Record<string, unknown> = {}) => ({
  date: '2026-02-01',
  payee: 'p',
  memo: '',
  outflow_cents: 100,
  inflow_cents: 0,
  category_id: null,
  ...extra,
});

const bodyCases: BodyCase[] = [
  // accounts
  { op: 'budget_accounts_create', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, name: 'x', type: 'checking', on_budget: true, balance_cents: 0, user_id: victim.id } },
  { op: 'budget_accounts_update', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { id: A.account, budget_id: A.budget, user_id: victim.id } },
  { op: 'budget_accounts_update', fields: ['link.connectionId'], outcome: 'reject', status: 404,
    input: { id: A.account, budget_id: A.budget, link: { connectionId: V.connection, externalAccountId: 'ext-1' } } },
  // assignments / plan
  { op: 'budget_assignments_set', fields: ['category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, month: MONTH, category_id: V.category, budgeted: 1000 } },
  { op: 'budget_assignments_batch', fields: ['updates[].category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, month: MONTH, updates: [{ category_id: A.category, budgeted: 1 }, { category_id: V.category, budgeted: 1000 }] } },
  { op: 'budget_plan_auto_assign', fields: ['rows[].category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, month: MONTH, rows: [{ category_id: V.category, assign_cents: 100 }] } },
  // categories / groups / bundles
  { op: 'budget_categories_create', fields: ['group_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, group_id: V.group, name: 'pwned', sort_order: 0 } },
  { op: 'budget_categories_create', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, group_id: A.group, name: 'pwned', sort_order: 0, user_id: victim.id } },
  { op: 'budget_categories_reorder', fields: ['moves[].id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, moves: [{ id: V.category, group_id: A.group, sort_order: 5 }] } },
  { op: 'budget_categories_reorder', fields: ['moves[].group_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, moves: [{ id: A.category, group_id: V.group, sort_order: 5 }] } },
  { op: 'budget_categories_set_group_person', fields: ['group_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, group_id: V.group, user_id: attacker.id } },
  { op: 'budget_categories_set_group_person', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, group_id: A.group, user_id: victim.id } },
  { op: 'budget_categories_set_person', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { id: A.category, budget_id: A.budget, user_id: victim.id } },
  { op: 'budget_bundles_create', fields: ['group_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, group_id: V.group, name: 'pwned', category_ids: [A.category, A.category2] } },
  { op: 'budget_bundles_create', fields: ['category_ids[]'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, group_id: A.group, name: 'pwned', category_ids: [A.category, V.category] } },
  { op: 'budget_categories_set_bundle', fields: ['category_ids[]'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, bundle_id: A.bundle, category_ids: [A.category, V.category] } },
  { op: 'budget_categories_set_bundle', fields: ['bundle_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, bundle_id: V.bundle, category_ids: [A.category] } },
  // members
  { op: 'budget_members_link_email', fields: ['user_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, user_id: victim.id, email: 'access-link@accesscatalog.test' } },
  { op: 'budget_members_rename', fields: ['user_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, user_id: victim.id, name: 'pwned' } },
  { op: 'budget_members_remove', fields: ['user_id'], outcome: 'ignored',
    input: { budget_id: A.budget, user_id: victim.id } },
  // payees
  { op: 'budget_payees_create', fields: ['default_category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, name: 'pwned', default_category_id: V.category } },
  { op: 'budget_payees_set_categorization', fields: ['default_category_id'], outcome: 'reject', status: 400,
    input: { id: A.payee, budget_id: A.budget, categorization_mode: 'fixed', default_category_id: V.category } },
  { op: 'budget_payees_merge', fields: ['target_id'], outcome: 'reject', status: 404,
    input: { id: A.payee, budget_id: A.budget, target_id: V.payee } },
  // repeat rules
  { op: 'budget_repeat_rules_create', fields: ['account_id'], outcome: 'reject', status: 400,
    input: ruleBase({ account_id: V.account }) },
  { op: 'budget_repeat_rules_create', fields: ['category_id'], outcome: 'reject', status: 400,
    input: ruleBase({ category_id: V.category }) },
  { op: 'budget_repeat_rules_create', fields: ['attach_transaction_id'], outcome: 'reject', status: 400,
    input: ruleBase({ next_due_date: undefined, attach_transaction_id: V.txn }) },
  // transactions
  { op: 'budget_transaction_add', fields: ['account_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, account_id: V.account, amount_cents: -100, payee: 'p' } },
  { op: 'budget_transaction_add', fields: ['category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, account_id: A.account, amount_cents: -100, payee: 'p', category_id: V.category } },
  { op: 'budget_transactions_bulk_import', fields: ['account_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, account_id: V.account, txns: [bulkRow()] } },
  { op: 'budget_transactions_bulk_import', fields: ['txns[].category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, account_id: A.account, txns: [bulkRow({ category_id: V.category })] } },
  { op: 'budget_transactions_create', fields: ['txn.account_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, txn: txnBase({ account_id: V.account }) } },
  { op: 'budget_transactions_create', fields: ['txn.category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, txn: txnBase({ category_id: V.category }) } },
  { op: 'budget_transactions_create', fields: ['txn.matched_transaction_id'], outcome: 'ignored',
    input: { budget_id: A.budget, txn: txnBase({ matched_transaction_id: V.txn }) } },
  { op: 'budget_transactions_create', fields: ['subtransactions[].category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, txn: txnBase(), subtransactions: [{ category_id: V.category, memo: null, outflow_cents: 100, inflow_cents: 0 }] } },
  { op: 'budget_transactions_update', fields: ['patch.account_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { account_id: V.account } } },
  { op: 'budget_transactions_update', fields: ['patch.category_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { category_id: V.category } } },
  { op: 'budget_transactions_update', fields: ['patch.matched_transaction_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { matched_transaction_id: V.txn } } },
  { op: 'budget_transactions_update', fields: ['subtransactions[].category_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: {}, subtransactions: [{ category_id: V.category, memo: null, outflow_cents: 500, inflow_cents: 0 }] } },
  // connections (the attacker's own connection, the victim's account)
  { op: 'connections_transactions_list', fields: ['accountId'], outcome: 'reject', status: 404,
    input: { id: A.connection, accountId: V.account } },
  // restore into a budget the attacker owns: foreign people fall back to Shared
  { op: 'budget_restore', fields: ['categories[].userId', 'accounts[].userId'], outcome: 'sanitised',
    input: {
      budget_id: A.restoreBudget,
      groups: ['G'],
      categories: [{ groupIndex: 0, name: 'C', userId: victim.id }],
      accounts: [{ name: 'Acc', userId: victim.id }],
      transactions: [],
      assignments: [],
    } },
];

/** Id-carrying fields that legitimately take another budget's id (reason required). Empty today. */
const allowedCrossBudget: Record<string, string> = {};

describe('access catalog coverage (body and query ids)', () => {
  test('every id-carrying body/query field has an attack case or an allow-list reason', () => {
    const covered = new Set(bodyCases.flatMap((bc) => bc.fields.map((f) => `${bc.op}:${f}`)));
    const missing = bodyIdFields.map((f) => `${f.op}:${f.field}`).filter((k) => !covered.has(k) && !(k in allowedCrossBudget));
    expect(missing).toEqual([]);
  });

  test('every case names a real operation field and parses against its contract', () => {
    const byName = new Map(scopedContracts.map((c) => [c.name, c]));
    const known = new Set(bodyIdFields.map((f) => `${f.op}:${f.field}`));
    for (const bc of bodyCases) {
      const c = byName.get(bc.op);
      expect(c, bc.op).toBeDefined();
      for (const f of bc.fields) expect(known.has(`${bc.op}:${f}`), `${bc.op}:${f} is not an id field of the contract`).toBe(true);
      const parsed = c!.input.safeParse(bc.input);
      expect(parsed.success ? 'ok' : JSON.stringify(parsed.error.issues), `${bc.op} ${bc.fields}`).toBe('ok');
    }
  });
});

describe.skipIf(!dbReady)('member of A supplying budget B ids in the body or query', () => {
  const byName = new Map(scopedContracts.map((c) => [c.name, c]));
  for (const bc of bodyCases) {
    test(`C: ${bc.op} ${bc.fields.join(',')} (${bc.outcome})`, async () => {
      const c = byName.get(bc.op)!;
      const scope = bc.input.budget_id as string | undefined;
      const victimBefore = await victimSnapshot();
      const ownBefore = scope ? await budgetSnapshot(scope) : '';
      const res = await app.request(buildRequest(c, bc.input));
      const text = await res.text();
      const label = `${bc.op} ${bc.fields}: status ${res.status} ${text.slice(0, 200)}`;

      if (bc.outcome === 'reject') {
        expect(res.status, label).toBe(bc.status ?? 404);
        if (scope) expect(await budgetSnapshot(scope), `${label}: attacker budget changed on a rejected request`).toBe(ownBefore);
      } else {
        expect(res.status, label).toBeLessThan(500);
      }
      expect(await victimSnapshot(), `${label}: victim budget changed`).toBe(victimBefore);
      for (const m of VICTIM_MARKERS) expect(text.includes(m), `${label}: response leaks victim data (${m})`).toBe(false);
      expect(await crossReferences([A.budget, A.restoreBudget]), `${label}: attacker rows now point at victim rows`).toEqual([]);
    });
  }
});

describe.skipIf(!dbReady)('controls: the same operations still work with the attacker\'s own ids', () => {
  const byName = new Map(scopedContracts.map((c) => [c.name, c]));
  const send = (name: string, input: Record<string, unknown>) => app.request(buildRequest(byName.get(name)!, input));

  test('assignments set and batch accept own categories', async () => {
    expect((await send('budget_assignments_set', { budget_id: A.budget, month: MONTH, category_id: A.category, budgeted: 1000 })).status).toBe(200);
    expect(
      (await send('budget_assignments_batch', { budget_id: A.budget, month: MONTH, updates: [{ category_id: A.category2, budgeted: 5 }] })).status,
    ).toBe(204);
  });

  test('reorder accepts an own group, including a tombstoned one', async () => {
    expect((await send('budget_categories_reorder', { budget_id: A.budget, moves: [{ id: A.category, group_id: A.group, sort_order: 3 }] })).status).toBe(204);
    await pool.query('UPDATE category_groups SET deleted = true WHERE id = $1', [A.group]);
    expect((await send('budget_categories_reorder', { budget_id: A.budget, moves: [{ id: A.category, group_id: A.group, sort_order: 4 }] })).status).toBe(204);
  });

  test('transaction edit accepts an own category and an own matched transaction', async () => {
    const patch = { category_id: A.category, matched_transaction_id: A.txn };
    expect((await send('budget_transactions_update', { id: A.txn, budget_id: A.budget, patch })).status).toBe(204);
    expect((await send('budget_transactions_update', { id: A.txn, budget_id: A.budget, patch: { matched_transaction_id: null } })).status).toBe(204);
  });
});
