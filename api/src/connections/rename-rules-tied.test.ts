/**
 * Overlapping rules whose payees all share one created_at (budget-mkrt, review N1).
 *
 * A fresh-start budget copy gives every payee the same created_at, and payees created in one request share now().
 * Main read the rules `ORDER BY created_at` and nothing else, so among overlapping rules (POSTO / POSTO SHELL) the one it
 * took was whatever order Postgres returned, and the row it stored holds that rule's splice. Nothing here can rebuild that
 * order, so recognition must not depend on it: a row stored with the splice of ANY matching rule is unchanged, and a
 * statement re-import counts under any of their keys.
 *
 * Expected state: testdata/main-rename-tied-capture.json, recorded by running main (f538f3f) 12 times with different
 * creation orders of the payees. Main stored one form every time; the other form (the specific rule's splice) is what a
 * planner choosing the other order stores, so it is written here literally and held to the same standard.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

import { contracts } from '../catalog';
import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { makeOpCaller } from '../core/test-op';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import budget from '../budget';
import * as store from './store';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

interface Row {
  external_id: string;
  amount: number;
  payee: string | null;
  import_payee_name: string | null;
  import_payee_name_original: string | null;
  shadow_payee: string;
}
interface BulkRow {
  amount: number;
  payee: string | null;
  import_payee_name: string;
  import_payee_name_original: string;
  key_payee: string;
  occ: number;
}
const fx = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'main-rename-tied-capture.json'), 'utf8')) as {
  same_in_all_runs: boolean;
  runs: string[];
  texts: [string, number][];
  main: { results: Record<string, Record<string, number>>; sync_rows: Row[]; bulk_rows: BulkRow[] };
  payees_gen: string[][];
  payees_spec: string[][];
};

/** The splice of the SPECIFIC rule instead of the general one (what another read order of equal rows stores). */
const OTHER_FORM: Record<string, string> = {
  'Posto shell 3': 'Shell 3',
  'Amazon prime br': 'Prime br',
  'Ifood club 1': 'Ifood Club 1',
  'Mercadoado livre 1': 'Mercado Livre 1',
  'Posto shell is': 'Shell Is',
};

const PROVIDER = 'testprovider-tied';
const user: IdentityUser = { id: crypto.randomUUID(), email: 'rules-tied@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const EXT = 'up-acc-tied-legacy';

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;

const budgets: string[] = [];
beforeAll(async () => {
  if (!dbReady) return;
  await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
});
afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  await pool.query('DELETE FROM connections WHERE provider = $1', [PROVIDER]);
});

describe.skipIf(!dbReady)('the capture is main\'s', () => {
  test('12 runs, one stored form, stable on main', () => {
    expect(fx.same_in_all_runs).toBe(true);
    expect(fx.runs).toHaveLength(12);
    expect(fx.main.results).toMatchObject({ s2: { updated: 0 }, b2: { imported: 0 } });
    expect(fx.main.sync_rows.map((r) => r.payee)).toContain('Posto shell 3');
  });
});

for (const created of ['gen', 'spec'] as const) {
  for (const form of ['main', 'other'] as const) {
    describe.skipIf(!dbReady)(`payees tied on created_at, created ${created === 'gen' ? 'general rule first' : 'specific rule first'}; rows stored in ${form === 'main' ? "main's recorded form" : 'the other form'}`, () => {
      const accounts = { itau: crypto.randomUUID(), savings: crypto.randomUUID() };
      const B = crypto.randomUUID();
      const payees = new Map<string, string>();
      let connId = '';
      const formOf = (name: string | null) => (form === 'main' || name === null ? name : (OTHER_FORM[name] ?? name));
      const sync = () => syncConnectionTransactions({ userId: user.id, connectionId: connId, aggregator, ignoreWatermark: true });
      const snapshot = async () => ({
        transactions: (await pool.query('SELECT id, account_id, amount::text, payee_id, import_id, import_payee_name, import_payee_name_original, cleared, approved, deleted FROM transactions WHERE budget_id = $1 ORDER BY import_id, id', [B])).rows,
        payees: (await pool.query('SELECT id, name, deleted FROM payees WHERE budget_id = $1 ORDER BY id', [B])).rows,
        shadows: (await pool.query('SELECT transaction_id, last_synced_payload, blocked, updated_at::text FROM connection_transactions WHERE budget_id = $1 ORDER BY transaction_id', [B])).rows,
      });
      const bulkRows = () => fx.texts.map(([payee, amount]) => ({ date, payee, memo: '', outflow: -amount, inflow: 0, category_id: null }));

      beforeAll(async () => {
        await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [B, `rules-tied-${created}-${form}`, user.id]);
        budgets.push(B);
        await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [B, user.id]);
        await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$3,'Itau Conta','checking','CASH',true),($2,$3,'Savings Conta','checking','CASH',true)`, [accounts.itau, accounts.savings, B]);
        const c = await store.upsertConnection({ userId: user.id, provider: PROVIDER, externalId: `up-item-tied-${created}-${form}-${user.id}`, clientUserId: `cu-${user.id}-${created}-${form}`, status: 'connected', environment: 'production' });
        connId = c.id;
        await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [c.id, EXT, accounts.itau, 'itau']);
        // Every payee carries ONE created_at; the rules are in the columns, as main left them.
        for (const [name, type, cond] of created === 'gen' ? fx.payees_gen : fx.payees_spec) {
          const r = await pool.query<{ id: string }>(`INSERT INTO payees (budget_id, name, rename_match_type, rename_condition, created_at) VALUES ($1,$2,$3,$4,'2026-01-01T00:00:00Z') RETURNING id`, [B, name, type, cond]);
          payees.set(name, r.rows[0]!.id);
        }
        const idOf = (name: string) => payees.get(name) ?? (async () => { const r = await pool.query<{ id: string }>('INSERT INTO payees (budget_id, name) VALUES ($1,$2) RETURNING id', [B, name]); payees.set(name, r.rows[0]!.id); return r.rows[0]!.id; })();
        const insert = async (account: string, amount: number, name: string | null, importId: string, importName: string | null, original: string | null) => {
          const payeeId = name === null ? null : await idOf(name);
          return (await pool.query<{ id: string }>(
            `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted, import_id, import_payee_name, import_payee_name_original) VALUES ($1,$2,$3,$4,$5,'cleared',false,'never',false,$6,$7,$8) RETURNING id`,
            [B, account, date, amount, payeeId, importId, importName, original],
          )).rows[0]!.id;
        };
        for (const r of fx.main.sync_rows) {
          const name = formOf(r.payee);
          const id = await insert(accounts.itau, r.amount, name, `${PROVIDER}:${r.external_id}`, name, name);
          await pool.query(
            `INSERT INTO connection_transactions (transaction_id, budget_id, provider, external_transaction_id, last_synced_payload, blocked, raw_payload, raw_received_at) VALUES ($1,$2,$3,$4,$5,false,$6,now())`,
            [id, B, PROVIDER, r.external_id, JSON.stringify({ date, amount: r.amount, memo: '', payee: name }), JSON.stringify({ id: r.external_id })],
          );
        }
        for (const r of fx.main.bulk_rows) {
          const name = formOf(r.payee);
          const keyName = form === 'main' ? r.key_payee : (OTHER_FORM[r.key_payee] ?? r.key_payee);
          await insert(accounts.savings, r.amount, name, `YNAB:${r.amount}:${date}:${await idOf(keyName)}:${r.occ}`, r.import_payee_name, r.import_payee_name_original);
        }
        for (const [account, col] of [[accounts.itau, 'cleared_balance'], [accounts.savings, 'cleared_balance']] as const) {
          await pool.query(`UPDATE accounts SET ${col} = (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account_id = $1) WHERE id = $1`, [account]);
        }
        await pool.query(readFileSync(join(import.meta.dir, '..', '..', 'db', 'migrations', '0121_payee_renaming_rules.sql'), 'utf8'));
        upstream = fx.texts.map(([d, amount], i) => ({ externalId: `t${i}`, externalAccountId: EXT, description: d, amount, date, currencyCode: null, cleared: true, raw: { id: `t${i}` } }));
      });

      test('a bank sync changes, creates and skips nothing, twice', async () => {
        const before = await snapshot();
        expect(await sync()).toMatchObject({ added: 0, updated: 0, blocked: 0, failed: 0, duplicates: fx.texts.length });
        expect(await sync()).toMatchObject({ added: 0, updated: 0, blocked: 0, failed: 0, duplicates: fx.texts.length });
        expect(await snapshot()).toEqual(before);
      });

      test('a statement re-import duplicates every row and creates nothing, twice', async () => {
        const before = await snapshot();
        for (let i = 0; i < 2; i++) {
          const res = (await op('budget_transactions_bulk_import', { budget_id: B, account_id: accounts.savings, txns: bulkRows() })).json;
          expect(res).toEqual({ imported: 0, duplicates: fx.texts.length });
        }
        expect(await snapshot()).toEqual(before);
      });
    });
  }
}
