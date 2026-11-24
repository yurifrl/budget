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
 *
 * D. two people, the whole catalog. Every operation in `catalog.ts` is
 *    classified: budget-scoped by `budget_id`, budget/connection-scoped by a
 *    path id (A), or listed with the reason it cannot reach another person's
 *    budget. Every `budget_id` operation is then called on A's budget with a
 *    request that would succeed for A, by B (an ordinary user who is not on
 *    it) and by an operator (the `admin` role, also not on it): 404, nothing
 *    changed, nothing of A's in the response. Then A adds B: every read
 *    answers 200 for B, the owner-only operations stay closed to B, and when
 *    A removes B the door is shut again. A new operation fails the coverage
 *    test until it is classified and has an input here.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts as budgetContracts } from '@shared/contracts/budget';
import { contracts as connectionsContracts } from '@shared/contracts/connections';
import { contracts as featuresContracts } from '@shared/contracts/features';
import { contracts as jobsContracts } from '@shared/contracts/jobs';
import { budgetListRowSchema } from '@shared/contracts/budget/outputs';
import { inputLocations, type OperationContract } from '@shared/operation-contract';
import { UUID_RE } from '@shared/validation';
import { z } from '@shared/zod';
import budget from './budget';
import { contracts as catalog } from './catalog';
import connections from './connections';
import { featuresRoutes } from './features';
import jobs from './jobs';
import { grantsRoutes } from './oauth';
import { pool } from './core/db';
import { dbReady } from './core/test-gate';
import { httpOnError } from './core/validate';
import { authConfig, configureAuth, type IdentityUser } from './user';

const mkUser = (tag: string): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `access-${tag}@accesscatalog.test`,
  googleSub: null,
  role: 'user',
  status: 'active',
});
const victim = mkUser('victim');
const attacker = mkUser('attacker');
/** The operator: `admin` role, on nobody's budget (section D). */
const operator: IdentityUser = { ...mkUser('operator'), role: 'admin' };
/** Who the request is made as. Sections A to C never change it. */
let acting: IdentityUser = attacker;

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
  c.set('user', acting);
  return next();
});
app.route('/', budget);
app.route('/connections', connections);
app.route('/jobs', jobs);
app.route('/', grantsRoutes);
app.route('/', featuresRoutes());

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
  budget_accounts_reconcile: { id: V.account, budget_id: A.budget, stated_balance: 0 },
  budget_accounts_update: { id: V.account, budget_id: A.budget, name: 'pwned' },
  budget_categories_delete: { id: V.category, budget_id: A.budget },
  budget_categories_rename: { id: V.category, budget_id: A.budget, name: 'pwned' },
  budget_categories_set_hidden: { id: V.category, budget_id: A.budget, hidden: true },
  budget_categories_set_notes: { id: V.category, budget_id: A.budget, notes: 'pwned' },
  budget_categories_set_person: { id: V.category, budget_id: A.budget, user_id: null },
  budget_categories_set_target: { id: V.category, budget_id: A.budget, target: { amount: 1000 } },
  budget_bundles_delete: { id: V.bundle, budget_id: A.budget },
  budget_bundles_rename: { id: V.bundle, budget_id: A.budget, name: 'pwned' },
  budget_category_notes_set: { categoryId: V.category, budget_id: A.budget, month: '2026-01-01', note: 'pwned' },
  budget_category_targets_delete: { categoryId: V.category, budget_id: A.budget },
  budget_category_targets_set: {
    categoryId: V.category,
    budget_id: A.budget,
    kind: 'monthly',
    amount: 1000,
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
  budget_payees_transfer_rule_get: { id: V.payee, budget_id: A.budget },
  budget_payees_set_transfer_rule: { id: V.payee, budget_id: A.budget, mode: 'auto' },
  budget_repeat_rules_delete: { id: V.rule, budget_id: A.budget },
  budget_transactions_delete: { id: V.txn, budget_id: A.budget },
  budget_transactions_get: { id: V.txn, budget_id: A.budget },
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
    'transfer_marks', 'transfer_links',
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
  ['payees', 'transfer_rule_account_id', 'accounts'],
  ['transfer_marks', 'transaction_id', 'transactions'],
  ['transfer_links', 'transaction_id', 'transactions'],
  ['transfer_links', 'peer_transaction_id', 'transactions'],
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
  for (const u of [victim, attacker, operator]) {
    await pool.query(`INSERT INTO public.users (id, email, role, signed_in_at) VALUES ($1, $2, $3, now())`, [u.id, u.email, u.role]);
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
  outflow: 1000,
  inflow: 0,
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
  outflow: 1000,
  inflow: 0,
  frequency: 'monthly',
  month_last_day: false,
  next_due_date: '2027-01-01',
  ...extra,
});
const bulkRow = (extra: Record<string, unknown> = {}) => ({
  date: '2026-02-01',
  payee: 'p',
  memo: '',
  outflow: 1000,
  inflow: 0,
  category_id: null,
  ...extra,
});

const bodyCases: BodyCase[] = [
  // accounts
  { op: 'budget_accounts_create', fields: ['user_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, name: 'x', type: 'checking', on_budget: true, balance: 0, user_id: victim.id } },
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
    input: { budget_id: A.budget, month: MONTH, rows: [{ category_id: V.category, assigned: 1000 }] } },
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
    input: { budget_id: A.budget, account_id: V.account, amount: -1000, payee: 'p' } },
  { op: 'budget_transaction_add', fields: ['category_id'], outcome: 'reject', status: 400,
    input: { budget_id: A.budget, account_id: A.account, amount: -1000, payee: 'p', category_id: V.category } },
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
    input: { budget_id: A.budget, txn: txnBase(), subtransactions: [{ category_id: V.category, memo: null, outflow: 1000, inflow: 0 }] } },
  { op: 'budget_transactions_update', fields: ['patch.account_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { account_id: V.account } } },
  { op: 'budget_transactions_update', fields: ['patch.category_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { category_id: V.category } } },
  { op: 'budget_transactions_update', fields: ['patch.matched_transaction_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: { matched_transaction_id: V.txn } } },
  { op: 'budget_transactions_update', fields: ['subtransactions[].category_id'], outcome: 'reject', status: 400,
    input: { id: A.txn, budget_id: A.budget, patch: {}, subtransactions: [{ category_id: V.category, memo: null, outflow: 5000, inflow: 0 }] } },
  // transfers between own accounts
  { op: 'budget_transfer_suggestions_list', fields: ['account_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, account_id: V.account } },
  { op: 'budget_transfers_link', fields: ['links[].transaction_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, links: [{ transaction_id: V.txn, account_id: A.account }] } },
  { op: 'budget_transfers_link', fields: ['links[].counterpart_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, links: [{ transaction_id: A.txn, counterpart_id: V.txn }] } },
  { op: 'budget_transfers_link', fields: ['links[].account_id'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, links: [{ transaction_id: A.txn, account_id: V.account }] } },
  { op: 'budget_transfers_unlink', fields: ['transaction_ids[]'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, transaction_ids: [A.txn, V.txn] } },
  { op: 'budget_transfers_mark', fields: ['transaction_ids[]'], outcome: 'reject', status: 404,
    input: { budget_id: A.budget, transaction_ids: [A.txn, V.txn], state: 'dismissed' } },
  { op: 'budget_payees_set_transfer_rule', fields: ['account_id'], outcome: 'reject', status: 400,
    input: { id: A.payee, budget_id: A.budget, mode: 'account', account_id: V.account } },
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

// ---- D. two people, the whole catalog ----------------------------------------

const byBudgetId = budgetContracts.filter((c) => c.expose.api && hasBudgetId(c));

/**
 * Operations that carry neither a `budget_id` nor a budget/connection path id,
 * each with the reason it cannot reach another person's budget. Anything new
 * in the catalog must be added here (or be scoped) before the coverage test
 * passes.
 */
const notBudgetAddressed: Record<string, string> = {
  ai_credentials_delete: "deletes the caller's own AI key: keyed by the session user, no id to pass",
  ai_credentials_get: "status of the caller's own AI key; never the secret",
  ai_credentials_save: "saves the caller's own AI key: keyed by the session user, no id to pass",
  ai_credentials_test: "checks the caller's own AI key (or the shared one), no budget data",
  ai_models_list: "lists models for the caller's own/shared AI key; no budget data",
  ai_provider_detect: 'shape-only provider guess; reads no stored data',
  budget_list: "lists only budgets the caller owns or is a member of (asserted below)",
  budget_create: 'creates a new budget owned by the caller',
  connections_connect_token: "mints a widget token bound to the caller's own user id",
  connections_credentials_delete: "deletes the caller's own key set: keyed by the session user, no id to pass (asserted below)",
  connections_credentials_get: "status of the caller's own key set, never the secret (asserted below)",
  connections_credentials_save: "saves the caller's own key set: keyed by the session user, no id to pass",
  connections_items_register: "registers a bank item for the caller; another user's item is 409",
  connections_list: "lists the caller's own connections (asserted below)",
  connections_settings_get: 'reads the app-wide sync window: one number, no budget data',
  connections_settings_update: 'app-wide sync window: admin only (403 asserted below)',
  connections_sync_status: "sync state of the caller's own connections",
  connections_upstream_list: "upstream accounts of the caller's own connections",
  features_admin_clear_everyone: 'feature toggles: admin + first-party session only (403 asserted below)',
  features_admin_clear_user: 'feature toggles: admin + first-party session only (403 asserted below)',
  features_admin_list: 'feature toggles: admin + first-party session only (403 asserted below)',
  features_admin_set_everyone: 'feature toggles: admin + first-party session only (403 asserted below)',
  features_admin_set_user: 'feature toggles: admin + first-party session only (403 asserted below)',
  features_mine: "the caller's own feature values, no budget data (asserted below)",
  jobs_cancel_run: 'jobs ledger: admin only (403 asserted below)',
  jobs_get_run: 'jobs ledger: admin only (403 asserted below)',
  jobs_health: 'jobs ledger: admin only (403 asserted below)',
  jobs_list_runs: 'jobs ledger: admin only (403 asserted below)',
  jobs_retry_run: 'jobs ledger: admin only (403 asserted below)',
  oauth_grants_list: "lists the caller's own grants (asserted below)",
  oauth_grants_revoke: "revokes the caller's own grant; another person's is 404 (asserted below)",
  rates_usd_brl: 'a public exchange rate, no budget data',
  user_admin_users_create: 'user management: admin + first-party session only (user/password.test.ts)',
  user_admin_users_delete: 'user management: admin + first-party session only (user/password.test.ts)',
  user_admin_users_list: 'user management: admin + first-party session only (user/password.test.ts)',
  user_admin_users_reset_password: 'user management: admin + first-party session only (user/password.test.ts)',
  user_admin_users_update: 'user management: admin + first-party session only (user/password.test.ts)',
  user_auth_me: "the caller's own e-mail",
  user_auth_password_change: "the caller's own password",
  user_auth_password_complete: 'pre-gate sign-in with a single-use change token, no budget data',
  user_auth_password_login: 'pre-gate sign-in, no budget data',
  user_auth_providers: 'which sign-in providers are on, no user data',
  user_me_avatar_remove: "the caller's own profile",
  user_me_get: "the caller's own profile",
  user_me_update: "the caller's own profile",
};

/**
 * A request on the VICTIM's budget that would succeed for the victim, per
 * `budget_id` operation: the path-param samples above re-aimed at V.budget,
 * plus an input for every operation without a path param.
 */
const onVictimBudget: Record<string, Record<string, unknown>> = {
  budget_accounts_create: { name: 'pwned', type: 'checking', on_budget: true, balance: 0 },
  budget_accounts_list: {},
  budget_assignments_batch: { month: MONTH, updates: [{ category_id: V.category, budgeted: 1 }] },
  budget_assignments_list: {},
  budget_assignments_set: { month: MONTH, category_id: V.category, budgeted: 1000 },
  budget_export: {},
  budget_restore: { groups: ['G'], categories: [], accounts: [], transactions: [], assignments: [] },
  budget_fresh_start: {},
  budget_categories_create: { group_id: V.group, name: 'pwned', sort_order: 0 },
  budget_categories_list: {},
  budget_categories_reorder: { moves: [{ id: V.category, group_id: V.group, sort_order: 5 }] },
  budget_categories_set_group_person: { group_id: V.group, user_id: victim.id },
  budget_bundles_create: { group_id: V.group, name: 'pwned', category_ids: [V.category, A.category] },
  budget_bundles_list: {},
  budget_categories_set_bundle: { bundle_id: V.bundle, category_ids: [V.category] },
  budget_category_notes_list: { month: MONTH },
  budget_category_targets_list: {},
  budget_groups_create: { name: 'pwned' },
  budget_groups_list: {},
  budget_members_add: { email: 'access-smuggled@accesscatalog.test' },
  budget_members_link_email: { user_id: victim.id, email: 'access-link@accesscatalog.test' },
  budget_members_list: {},
  budget_members_remove: { user_id: victim.id },
  budget_members_rename: { user_id: victim.id, name: 'pwned' },
  budget_month_notes_list: {},
  budget_month_notes_set: { month: MONTH, note: 'pwned' },
  budget_payees_create: { name: 'pwned' },
  budget_payees_list: {},
  budget_payees_merge: { id: V.payee, target_id: V.payee },
  budget_plan_auto_assign: { month: MONTH, rows: [{ category_id: V.category, assigned: 1000 }] },
  budget_repeat_rules_create: ruleBase({ account_id: V.account }),
  budget_repeat_rules_generate: {},
  budget_repeat_rules_list: {},
  budget_revision_get: {},
  budget_transaction_add: { account_id: V.account, amount: -1000, payee: 'p' },
  budget_transactions_bulk_import: { account_id: V.account, txns: [bulkRow()] },
  budget_transactions_create: { txn: txnBase({ account_id: V.account }) },
  budget_transactions_list: {},
  budget_transfer_suggestions_list: { account_id: V.account },
  budget_transfers_link: { links: [{ transaction_id: V.txn, account_id: V.account }] },
  budget_transfers_unlink: { transaction_ids: [V.txn] },
  budget_transfers_mark: { transaction_ids: [V.txn], state: 'dismissed' },
};
const victimInput = (c: OperationContract): Record<string, unknown> | undefined => {
  const base = onVictimBudget[c.name] ?? samples[c.name];
  return base && { ...base, budget_id: V.budget };
};
const allMarkers = [...VICTIM_MARKERS, 'victim month note'];

describe('access catalog coverage (every operation, two people)', () => {
  test('every catalog operation is budget-scoped, path-scoped (A) or listed with a reason', () => {
    const pathScoped = new Set(pathOps.map((c) => c.name));
    const unclassified = catalog
      .filter((c) => c.expose.api)
      .filter((c) => !(c.name.startsWith('budget_') && hasBudgetId(c)) && !pathScoped.has(c.name) && !(c.name in notBudgetAddressed))
      .map((c) => c.name);
    expect(unclassified).toEqual([]);
    // Only budget operations may rely on `budget_id` + budgetAccess.
    expect(catalog.filter((c) => hasBudgetId(c) && !c.name.startsWith('budget_')).map((c) => c.name)).toEqual([]);
  });

  test('every budget_id operation has a request on the victim budget that parses against its contract', () => {
    for (const c of byBudgetId) {
      const input = victimInput(c);
      expect(input, `${c.name}: no input`).toBeDefined();
      const parsed = c.input.safeParse(input);
      expect(parsed.success ? 'ok' : JSON.stringify(parsed.error.issues), c.name).toBe('ok');
      expect((input as { budget_id: string }).budget_id).toBe(V.budget);
    }
  });
});

describe.skipIf(!dbReady)('D: two people, every budget operation', () => {
  const byName = new Map(catalog.map((c) => [c.name, c]));
  const send = (name: string, input: Record<string, unknown>) => app.request(buildRequest(byName.get(name)!, input));
  const listAs = async (who: IdentityUser) => {
    acting = who;
    const res = await send('budget_list', {});
    expect(res.status).toBe(200);
    return z.array(budgetListRowSchema).parse(await res.json());
  };

  afterAll(async () => {
    acting = attacker;
    if (!dbReady) return;
    await pool.query('DELETE FROM public.budget_members WHERE budget_id = $1 AND user_id <> $2', [V.budget, victim.id]);
    await pool.query(`DELETE FROM public.oauth_clients WHERE client_id = 'c_access_catalog_test'`);
  });

  for (const [who, label] of [[attacker, 'another user'], [operator, 'an admin who is not on the budget']] as const) {
    for (const c of byBudgetId) {
      test(`${c.method} ${c.path} (${c.name}) on the victim's budget is 404 for ${label}`, async () => {
        acting = who;
        const before = await victimSnapshot();
        const res = await app.request(buildRequest(c, victimInput(c)!));
        const text = await res.text();
        expect(res.status, `${c.name}: ${text.slice(0, 200)}`).toBe(404);
        expect(await victimSnapshot(), `${c.name}: victim budget changed`).toBe(before);
        for (const m of allMarkers) expect(text.includes(m), `${c.name}: response leaks victim data (${m})`).toBe(false);
      });
    }

    test(`path-id budget operations (rename, archive, unarchive, delete) are 404 for ${label}`, async () => {
      acting = who;
      const before = await victimSnapshot();
      for (const name of ['budget_rename', 'budget_archive', 'budget_unarchive', 'budget_delete']) {
        expect((await send(name, samples[name]!)).status, name).toBe(404);
      }
      expect(await victimSnapshot()).toBe(before);
    });

    test(`the budgets list of ${label} does not contain the victim's budget`, async () => {
      const list = await listAs(who);
      expect(list.some((b) => b.id === V.budget)).toBe(false);
      expect(JSON.stringify(list).includes('access-victim')).toBe(false);
    });
  }

  test('a refused budget_members_add provisions nobody', async () => {
    const r = await pool.query(`SELECT 1 FROM public.users WHERE email = 'access-smuggled@accesscatalog.test'`);
    expect(r.rowCount).toBe(0);
  });

  test("connections: another user's list is their own; the app-wide sync window is admin-only", async () => {
    acting = attacker;
    const res = await send('connections_list', {});
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text.includes(A.connection)).toBe(true);
    expect(text.includes(V.connection)).toBe(false);
    expect((await send('connections_settings_update', { syncWindowDays: 7 })).status).toBe(403);
  });

  test("own bank keys: a user reads and deletes only their own key set, and the secret is never in an answer", async () => {
    // The victim's key set, stored directly (the bytes stand in for ciphertext + nonce).
    await pool.query(
      `INSERT INTO public.connection_credentials (user_id, provider, client_id, secret_ciphertext, secret_nonce, key_version)
       VALUES ($1, 'pluggy', 'victim-client-id', $2, $3, 1)`,
      [victim.id, Buffer.from('victim-sealed-secret'), Buffer.from('victim-nonce')],
    );
    for (const who of [attacker, operator]) {
      acting = who;
      const res = await send('connections_credentials_get', {});
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ provider: 'pluggy', clientId: null, hasSecret: false, updatedAt: null });
      expect((await send('connections_credentials_delete', {})).status).toBe(200);
    }
    const kept = await pool.query(`SELECT client_id FROM public.connection_credentials WHERE user_id = $1`, [victim.id]);
    expect(kept.rows).toEqual([{ client_id: 'victim-client-id' }]);

    acting = victim;
    const own = await send('connections_credentials_get', {});
    const text = await own.text();
    expect(JSON.parse(text)).toMatchObject({ provider: 'pluggy', clientId: 'victim-client-id', hasSecret: true });
    expect(text.includes('victim-sealed-secret')).toBe(false);
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(['clientId', 'hasSecret', 'provider', 'updatedAt']);
    acting = attacker;
  });

  test('the connection summary and transactions show nothing from a budget its owner is no longer on', async () => {
    // The victim's bank is linked to an account in the ATTACKER's budget (which the victim is not on),
    // and both linked accounts hold an imported transaction, so both would be in the summary.
    await pool.query(`UPDATE accounts SET connection_id = $2, external_account_id = 'ext-a' WHERE id = $1`, [A.account, V.connection]);
    await pool.query(
      `INSERT INTO public.connection_transactions (transaction_id, provider, external_transaction_id)
       VALUES ($1::uuid, 'access-test', $1::uuid::text), ($2::uuid, 'access-test', $2::uuid::text)`,
      [V.txn, A.txn],
    );
    try {
      acting = victim;
      const summary = await send('connections_accounts_summary', { id: V.connection });
      expect(summary.status).toBe(200);
      const text = await summary.text();
      expect(text.includes('Victim Checking')).toBe(true); // the account in their own budget
      expect(text.includes('Attacker Checking')).toBe(false);
      expect(text.includes(A.account)).toBe(false);
      expect((await send('connections_transactions_list', { id: V.connection, accountId: A.account })).status).toBe(404);
      const own = await send('connections_transactions_list', { id: V.connection, accountId: V.account });
      expect(own.status).toBe(200);
      expect((await own.text()).includes(V.txn)).toBe(true);

      // Disconnecting does not get stuck on (or name) the account they cannot reach: that link is dropped.
      const del = await send('connections_delete', { id: V.connection });
      expect(del.status).toBe(409);
      const message = await del.text();
      expect(message.includes('Victim Checking')).toBe(true);
      expect(message.includes('Attacker Checking')).toBe(false);
      expect((await pool.query('SELECT connection_id FROM accounts WHERE id = $1', [A.account])).rows[0].connection_id).toBeNull();
    } finally {
      await pool.query(`UPDATE accounts SET connection_id = NULL, external_account_id = NULL WHERE id = $1`, [A.account]);
      await pool.query('DELETE FROM public.connection_transactions WHERE transaction_id = ANY($1)', [[V.txn, A.txn]]);
    }
  });

  test('jobs ledger: 403 for an ordinary user on every operation', async () => {
    acting = attacker;
    for (const c of jobsContracts.filter((op) => op.expose.api)) {
      const input = inputLocations(c).path.length > 0 ? { id: crypto.randomUUID() } : {};
      expect((await app.request(buildRequest(c, input))).status, c.name).toBe(403);
    }
  });

  test('features: 403 for an ordinary user on every admin operation; a user reads only their own values', async () => {
    // The harness sets the user with no session principal, so the first-party
    // guard passes only with auth off: every 403 below is the admin check.
    const before = authConfig();
    configureAuth({ ...before, authDisabled: true });
    const key = 'shared-pluggy-key';
    const adminInputs: Record<string, Record<string, unknown>> = {
      features_admin_list: {},
      features_admin_set_everyone: { key, value: true },
      features_admin_clear_everyone: { key },
      features_admin_set_user: { key, user_id: attacker.id, value: true },
      features_admin_clear_user: { key, user_id: victim.id },
    };
    const adminOps = featuresContracts.filter((c) => c.name !== 'features_mine');
    const stored = async () => (await pool.query('SELECT user_id, value FROM public.feature_overrides WHERE feature_key = $1 ORDER BY user_id NULLS FIRST', [key])).rows;
    try {
      expect(adminOps.map((c) => c.name).sort()).toEqual(Object.keys(adminInputs).sort());
      await pool.query('DELETE FROM public.feature_overrides WHERE feature_key = $1', [key]);
      // The operator (admin role) turns the feature on for the victim only.
      acting = operator;
      expect((await send('features_admin_list', {})).status).toBe(200);
      expect((await send('features_admin_set_user', { key, user_id: victim.id, value: true })).status).toBe(200);
      const expected = [{ user_id: victim.id, value: true }];
      expect(await stored()).toEqual(expected);

      for (const who of [attacker, victim]) {
        acting = who;
        for (const c of adminOps) expect((await app.request(buildRequest(c, adminInputs[c.name]!))).status, `${c.name} as ${who.email}`).toBe(403);
      }
      // No refused write changed anything: the attacker gave themself nothing and took nothing from the victim.
      expect(await stored()).toEqual(expected);

      acting = attacker;
      const mine = await send('features_mine', {});
      expect(mine.status).toBe(200);
      expect(await mine.json()).toEqual({ features: { [key]: false, 'shared-ai-key': false } });
      acting = victim;
      expect(await (await send('features_mine', {})).json()).toEqual({ features: { [key]: true, 'shared-ai-key': false } });
    } finally {
      await pool.query('DELETE FROM public.feature_overrides WHERE feature_key = $1', [key]);
      configureAuth(before);
    }
  });

  test("OAuth grants: another user's grant is neither listed nor revocable", async () => {
    await pool.query(
      `INSERT INTO public.oauth_clients (client_id, client_name, redirect_uris) VALUES ('c_access_catalog_test', 'Victim App', '{http://localhost/cb}')`,
    );
    const grant = (
      await pool.query<{ id: string }>(
        `INSERT INTO public.oauth_grants (id, user_id, client_id, scope, resource, expires_at)
         VALUES (gen_random_uuid(), $1, 'c_access_catalog_test', 'read', 'r', now() + interval '1 hour') RETURNING id`,
        [victim.id],
      )
    ).rows[0]!.id;
    acting = attacker;
    const list = await send('oauth_grants_list', {});
    expect(list.status).toBe(200);
    expect((await list.text()).includes('Victim App')).toBe(false);
    expect((await send('oauth_grants_revoke', { id: grant })).status).toBe(404);
    expect((await pool.query('SELECT revoked_at FROM public.oauth_grants WHERE id = $1', [grant])).rows[0].revoked_at).toBeNull();
  });

  test('then the owner shares the budget: the other person can read everything, and it shows as shared with them', async () => {
    acting = victim;
    const added = await send('budget_members_add', { budget_id: V.budget, email: attacker.email });
    expect(added.status).toBe(200);
    // Same user row (invited by e-mail), not a second one.
    expect((await pool.query('SELECT user_id FROM public.budget_members WHERE budget_id = $1 ORDER BY added_at', [V.budget])).rows.map((r) => r.user_id).sort()).toEqual(
      [victim.id, attacker.id].sort(),
    );

    const shared = (await listAs(attacker)).find((b) => b.id === V.budget);
    expect(shared).toMatchObject({ is_owner: false, member_count: 2, owner: { user_id: victim.id, email: victim.email } });
    const own = (await listAs(attacker)).find((b) => b.id === A.budget);
    expect(own).toMatchObject({ is_owner: true, member_count: 1, owner: { user_id: attacker.id } });
    expect((await listAs(victim)).find((b) => b.id === V.budget)).toMatchObject({ is_owner: true, member_count: 2 });
    // The operator still sees neither.
    expect(await listAs(operator)).toEqual([]);

    acting = attacker;
    for (const c of byBudgetId.filter((op) => op.kind === 'read')) {
      const res = await app.request(buildRequest(c, victimInput(c)!));
      const body = await res.text();
      expect(res.status, `${c.name}: ${body.slice(0, 200)}`).toBe(200);
      expect(c.output!.safeParse(JSON.parse(body)).success, `${c.name}: output does not parse`).toBe(true);
    }
    const accounts = await (await send('budget_accounts_list', { budget_id: V.budget })).text();
    expect(accounts.includes('Victim Checking')).toBe(true);
  });

  test('a member who is not the owner cannot rename, archive, delete, restore, fresh-start or remove people', async () => {
    acting = attacker;
    const before = await victimSnapshot();
    for (const [name, input] of [
      ['budget_rename', samples.budget_rename!],
      ['budget_archive', samples.budget_archive!],
      ['budget_unarchive', samples.budget_unarchive!],
      ['budget_delete', samples.budget_delete!],
      ['budget_fresh_start', { budget_id: V.budget }],
      ['budget_restore', { ...onVictimBudget.budget_restore, budget_id: V.budget }],
      ['budget_members_remove', { budget_id: V.budget, user_id: victim.id }],
      ['budget_members_remove', { budget_id: V.budget, user_id: attacker.id }],
    ] as const) {
      const res = await send(name, input);
      expect(res.status, name).toBe(404);
    }
    expect(await victimSnapshot()).toBe(before);
    const members = await (await send('budget_members_list', { budget_id: V.budget })).json();
    expect(members.can_manage).toBe(false);
    // The owner is told they can manage, and cannot remove themselves.
    acting = victim;
    expect((await (await send('budget_members_list', { budget_id: V.budget })).json()).can_manage).toBe(true);
    expect((await send('budget_members_remove', { budget_id: V.budget, user_id: victim.id })).status).toBe(400);
  });

  test('when the owner removes them the budget is closed again', async () => {
    acting = victim;
    expect((await send('budget_members_remove', { budget_id: V.budget, user_id: attacker.id })).status).toBe(200);
    acting = attacker;
    for (const c of byBudgetId.filter((op) => op.kind === 'read')) {
      expect((await app.request(buildRequest(c, victimInput(c)!))).status, c.name).toBe(404);
    }
    expect((await listAs(attacker)).some((b) => b.id === V.budget)).toBe(false);
  });
});
