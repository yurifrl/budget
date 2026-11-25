/**
 * A renaming rule applies going forward only (budget-ou8p).
 *
 * Adding, changing or removing a rule never changes the payee of a transaction that is already stored, by itself: not at the
 * next bank sync and not through a statement re-import (whose changed resolution used to change the import key and bring the
 * file's rows in again). Rows INSERTED afterwards take the rule, and so do rows whose bank text really changes. Applying a rule
 * to the past is a separate, deliberate act (preview, apply, revert).
 *
 * The budget is the one main left (testdata/main-rename-capture.json, recorded by running main: legacy spliced payees,
 * double spaces, overlapping rules, transfer-payee rules, an edited row, client-style statement rows); the rows are written
 * literally from the capture, with a provider object that carries the bank text as a real provider's does. The bank rows' rules
 * are then changed through the API and every pass is checked against a snapshot of the whole budget.
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
// The store under test (a test may reach into a feature's internals).
// eslint-disable-next-line import/no-restricted-paths
import { lockBudgetImportWrites, listApplyRows } from '../budget/store/rename-apply';
import { syncConnectionTransactions } from './sync';
import type { AggregatedTransaction, BankAggregator } from './types';

interface Capture {
  texts: [string, number][];
  client: { payee: string; original: string; amount: number }[];
  main_results: Record<string, Record<string, number>>;
  payees: { name: string; transfer: string | null; type: string | null; condition: string | null }[];
  sync_rows: {
    external_id: string;
    amount: number;
    payee: string | null;
    import_payee_name: string | null;
    import_payee_name_original: string | null;
    shadow_payee: string;
    blocked: boolean;
    hint_account: string | null;
    untouched: boolean;
  }[];
  bulk_rows: BulkCaptured[];
  client_rows: BulkCaptured[];
}
interface BulkCaptured {
  amount: number;
  payee: string | null;
  import_payee_name: string;
  import_payee_name_original: string;
  hint: string | null;
  untouched: boolean;
  key_payee: string;
  occ: number;
}
const fx = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'main-rename-capture.json'), 'utf8')) as Capture;
const MIGRATION = readFileSync(join(import.meta.dir, '..', '..', 'db', 'migrations', '0121_payee_renaming_rules.sql'), 'utf8');

const PROVIDER = 'testprovider-forward';
const user: IdentityUser = { id: crypto.randomUUID(), email: 'rules-forward@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const EXT_ITAU = 'up-acc-forward-itau';
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const ACCOUNT_NAMES = ['Itau Conta', 'Nubank Conta', 'Third Conta', 'Savings Conta', 'Cartao Conta'];

let upstream: AggregatedTransaction[] = [];
let activeUser = user.id;
const aggregator = {
  environment: 'production',
  listTransactions: async (accountId: string) => ({ transactions: accountId === EXT_ITAU ? upstream.map((t) => ({ ...t })) : [], hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
/** What the provider object stored with the legacy rows says about the text: it carries it, lacks it, or there is no object at all (rows older than raw storage). */
type StoredRaw = 'text' | 'none' | 'null';
let storedRaw: StoredRaw = 'text';
/** Every pull's provider object differs from the one before in fields that have nothing to do with the text (a real provider object carries balances, status, timestamps). */
let pullNo = 0;
const volatile = () => ({ balance: 1000 + pullNo * 7, updatedAt: `2026-11-25T10:00:${String(pullNo % 60).padStart(2, '0')}Z`, status: pullNo % 2 ? 'POSTED' : 'PENDING' });
const up = (externalId: string, description: string, amount: number): AggregatedTransaction => ({
  externalId,
  externalAccountId: EXT_ITAU,
  description,
  amount,
  date,
  currencyCode: null,
  cleared: true,
  raw: { id: externalId, description, ...volatile() },
});
const mainUpstream = () => {
  pullNo += 1;
  return fx.texts.map(([text, amount], i) => up(`c${i}`, text, amount));
};
const plainRows = (texts = fx.texts) => texts.map(([payee, amount]) => ({ date, payee, memo: '', outflow: -amount, inflow: 0, category_id: null }));
const clientRows = (rows = fx.client) =>
  rows.map((r) => ({ date, payee: r.payee, memo: '', outflow: -r.amount, inflow: 0, category_id: null, import_payee_name: r.payee, import_payee_name_original: r.original }));

interface Ctx {
  B: string;
  accounts: Record<string, string>;
  payees: Map<string, string>;
  connId: string;
  sync(): ReturnType<typeof syncConnectionTransactions>;
  bulk(account: string, rows: object[]): Promise<{ imported: number; duplicates: number }>;
  idOf(name: string): string;
  snapshot(): Promise<unknown>;
}

/** The budget as main left it: the rules in the payee columns, the rows main stored, written literally. `migrate`: run 0121 (else the columns alone carry the rules). */
async function build(label: string, migrate: boolean): Promise<Ctx> {
  const B = crypto.randomUUID();
  const accounts: Record<string, string> = Object.fromEntries(ACCOUNT_NAMES.map((n) => [n, crypto.randomUUID()]));
  const itau = accounts['Itau Conta']!;
  const payees = new Map<string, string>();
  const idOf = (name: string) => payees.get(name) ?? (() => { throw new Error(`no payee ${name}`); })();
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [B, `rules-forward-${label}`, user.id]);
  await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [B, user.id]);
  for (const [name, id] of Object.entries(accounts)) {
    await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$2,$3,'checking','CASH',true)`, [id, B, name]);
  }
  const conn = await store.upsertConnection({ userId: user.id, provider: PROVIDER, externalId: `up-item-forward-${label}-${user.id}`, clientUserId: `cu-${user.id}-${label}`, status: 'connected', environment: 'production' });
  await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [conn.id, EXT_ITAU, itau, 'itau']);

  // Payees in main's creation order, each with its one rule in the COLUMNS.
  for (const p of fx.payees) {
    const accountId = p.transfer ? accounts[p.transfer]! : null;
    const r = await pool.query<{ id: string }>(
      'INSERT INTO payees (budget_id, name, transfer_account_id, rename_match_type, rename_condition) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [B, p.name, accountId, p.type, p.condition],
    );
    payees.set(p.name, r.rows[0]!.id);
    if (accountId) await pool.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [r.rows[0]!.id, accountId]);
  }
  // Rows main stored.
  const insert = async (accountId: string, o: { amount: number; payee: string | null; importId: string; importName: string | null; importOriginal: string | null }) =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted, import_id, import_payee_name, import_payee_name_original)
         VALUES ($1,$2,$3,$4,$5,$6,false,'never',false,$7,$8,$9) RETURNING id`,
        [B, accountId, date, o.amount, o.payee === null ? null : idOf(o.payee), accountId === itau ? 'cleared' : 'uncleared', o.importId, o.importName, o.importOriginal],
      )
    ).rows[0]!.id;
  for (const r of fx.sync_rows) {
    const id = await insert(itau, { amount: r.amount, payee: r.payee, importId: `${PROVIDER}:${r.external_id}`, importName: r.import_payee_name, importOriginal: r.import_payee_name_original });
    await pool.query(
      `INSERT INTO connection_transactions (transaction_id, budget_id, provider, external_transaction_id, last_synced_payload, blocked, raw_payload, raw_received_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,now())`,
      [id, B, PROVIDER, r.external_id, JSON.stringify({ date, amount: r.amount, memo: '', payee: r.shadow_payee }), r.blocked, storedRaw === 'null' ? null : JSON.stringify(storedRaw === 'none' ? { id: r.external_id } : { id: r.external_id, description: fx.texts[Number(r.external_id.slice(1))]![0] })],
    );
    if (r.hint_account) await pool.query('INSERT INTO transfer_hints (transaction_id, budget_id, account_id) VALUES ($1,$2,$3)', [id, B, accounts[r.hint_account]]);
  }
  for (const [account, rows] of [['Savings Conta', fx.bulk_rows], ['Cartao Conta', fx.client_rows]] as const) {
    for (const r of rows) {
      const id = await insert(accounts[account]!, {
        amount: r.amount,
        payee: r.payee,
        importId: `YNAB:${r.amount}:${date}:${idOf(r.key_payee)}:${r.occ}`,
        importName: r.import_payee_name,
        importOriginal: r.import_payee_name_original,
      });
      if (r.hint) await pool.query('INSERT INTO transfer_hints (transaction_id, budget_id, account_id) VALUES ($1,$2,$3)', [id, B, accounts[r.hint]]);
    }
  }
  for (const [accountId, col] of [[itau, 'cleared_balance'], [accounts['Savings Conta']!, 'uncleared_balance'], [accounts['Cartao Conta']!, 'uncleared_balance']] as const) {
    await pool.query(`UPDATE accounts SET ${col} = (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account_id = $1) WHERE id = $1`, [accountId]);
  }
  if (migrate) await pool.query(MIGRATION);

  return {
    B,
    accounts,
    payees,
    connId: conn.id,
    sync: () => syncConnectionTransactions({ userId: user.id, connectionId: conn.id, aggregator, ignoreWatermark: true }),
    bulk: async (account, rows) =>
      (await op('budget_transactions_bulk_import', { budget_id: B, account_id: accounts[account], txns: rows })).json as { imported: number; duplicates: number },
    idOf,
    snapshot: async () => ({
      transactions: (
        await pool.query(
          `SELECT t.id, t.account_id, t.date::text AS date, t.amount::text AS amount, t.payee_id, t.import_id, t.import_payee_name,
                  t.import_payee_name_original, t.cleared, t.approved, t.deleted, t.category_id, t.memo
             FROM transactions t WHERE t.budget_id = $1 ORDER BY t.import_id, t.id`,
          [B],
        )
      ).rows,
      payees: (await pool.query('SELECT id, name, deleted, transfer_account_id FROM payees WHERE budget_id = $1 ORDER BY id', [B])).rows,
      shadows: (await pool.query('SELECT transaction_id, last_synced_payload, blocked, updated_at::text AS updated_at FROM connection_transactions WHERE budget_id = $1 ORDER BY transaction_id', [B])).rows,
      hints: (await pool.query('SELECT transaction_id, account_id FROM transfer_hints WHERE budget_id = $1 ORDER BY transaction_id', [B])).rows,
      balances: (await pool.query('SELECT id, cleared_balance::text AS c, uncleared_balance::text AS u FROM accounts WHERE budget_id = $1 ORDER BY id', [B])).rows,
    }),
  };
}

const budgets: string[] = [];
const rulesOf = async (c: Ctx, payee: string) => (await op('budget_payees_rename_rules_list', { id: c.idOf(payee), budget_id: c.B })).json as { id: string; match_type: string; condition: string }[];
type Snap = { transactions: { id: string; account_id: string; payee_id: string | null; import_id: string; import_payee_name: string | null; category_id: string | null }[]; payees: { id: string; name: string }[]; hints: { transaction_id: string; account_id: string }[]; shadows: { transaction_id: string; last_synced_payload: { payee: string } }[] };
const txnOf = (snap: Snap, ext: string) => snap.transactions.find((t) => t.import_id === `${PROVIDER}:${ext}`)!;

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
});
afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  await pool.query('DELETE FROM connections WHERE provider = $1', [PROVIDER]);
  void activeUser;
});

/** Two quiet passes of everything that could re-resolve a stored row: sync twice, a statement re-import twice (plain and client rows). */
async function quiet(c: Ctx, label: string) {
  const before = await c.snapshot();
  upstream = mainUpstream();
  for (let pass = 0; pass < 2; pass++) {
    expect(await c.sync(), `${label}: sync ${pass}`).toMatchObject({ added: 0, updated: 0, deleted: 0, blocked: 1, failed: 0, duplicates: 23 });
    expect(await c.bulk('Savings Conta', plainRows()), `${label}: bulk ${pass}`).toEqual({ imported: 0, duplicates: 24 });
    expect(await c.bulk('Cartao Conta', clientRows()), `${label}: client ${pass}`).toEqual({ imported: 0, duplicates: 4 });
  }
  // Nothing moved: no payee, no key, no shadow, no hint, no balance (payees created: none).
  expect(await c.snapshot(), label).toEqual(before);
}

const CHANGES: { name: string; change: (c: Ctx) => Promise<void> }[] = [
  {
    name: 'a rule ADDED that matches stored texts',
    change: async (c) => {
      // "Corner Shop" (-7000) is stored under its own payee; "Padaria" (-19000) and "pix sav" too. The new rules would re-point them.
      expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).status).toBe(201);
      expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'contains', condition: 'PADARIA' })).status).toBe(201);
      expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'starts_with', condition: 'UBER' })).status).toBe(201);
    },
  },
  {
    name: 'a rule EDITED so it matches other texts',
    change: async (c) => {
      const [uber] = await rulesOf(c, 'Uber');
      expect((await op('budget_payees_rename_rules_update', { id: c.idOf('Uber'), budget_id: c.B, rule_id: uber!.id, match_type: 'contains', condition: 'TRIP' })).status).toBe(200);
      const [padaria] = await rulesOf(c, 'Padaria');
      expect((await op('budget_payees_rename_rules_update', { id: c.idOf('Padaria'), budget_id: c.B, rule_id: padaria!.id, match_type: 'is', condition: 'PADOCA 42' })).status).toBe(200);
      const [netflix] = await rulesOf(c, 'Netflix');
      expect((await op('budget_payees_rename_rules_update', { id: c.idOf('Netflix'), budget_id: c.B, rule_id: netflix!.id, match_type: 'contains', condition: 'NETFLIX' })).status).toBe(200);
    },
  },
  {
    name: 'rules REMOVED',
    change: async (c) => {
      for (const payee of ['Netflix', 'Padaria', 'Uber', 'Mercado Livre', 'Transfer : Nubank Conta', ' Padded ', 'Shop']) {
        for (const rule of await rulesOf(c, payee)) {
          expect((await op('budget_payees_rename_rules_remove', { id: c.idOf(payee), budget_id: c.B, rule_id: rule.id })).status).toBe(204);
        }
      }
    },
  },
];

const VARIANTS: [boolean, StoredRaw][] = [[true, 'text'], [false, 'text'], [true, 'none'], [true, 'null']];
for (const [migrate, raw] of VARIANTS) {
  for (const { name, change } of CHANGES) {
    describe.skipIf(!dbReady)(`${name}, rows main stored (${migrate ? 'rules copied by migration 0121' : 'rules read from the payee columns'}; stored provider object: ${raw === 'text' ? 'carries the text' : raw === 'none' ? 'lacks the text' : 'none'}; the object changes on every pull)`, () => {
      let c: Ctx;
      beforeAll(async () => {
        storedRaw = raw;
        c = await build(`${migrate ? 'm' : 'c'}${raw}${CHANGES.findIndex((x) => x.name === name)}`, migrate);
        storedRaw = 'text';
        budgets.push(c.B);
        // The column-only budget needs the rules as rows to be edited through the API: the first rule write adopts them.
      });

      test('nothing stored moves: sync twice and a statement re-import twice change, import and create nothing', async () => {
        await change(c);
        await quiet(c, name);
      });

      test('rows inserted afterwards take the rules; a row whose bank text really changes takes them too; the rest stays', async () => {
        const before = (await c.snapshot()) as Snap;
        upstream = mainUpstream().map((t) => (t.externalId === 'c7' ? { ...t, description: 'PADOCA 7', raw: { id: 'c7', description: 'PADOCA 7', ...volatile() } } : t));
        upstream.push(up('fwd1', 'Corner Shop', -1234), up('fwd2', 'PADARIA SANTA 3', -2345));
        const result = await c.sync();
        expect(result).toMatchObject({ added: 2, updated: 1, failed: 0 });
        const after = (await c.snapshot()) as Snap;
        const byId = new Map(before.transactions.map((t) => [t.id, t]));
        const moved = after.transactions.filter((t) => byId.has(t.id) && JSON.stringify(byId.get(t.id)) !== JSON.stringify(t));
        expect(moved.map((t) => t.import_id)).toEqual([`${PROVIDER}:c7`]);
        // c7's text changed to PADOCA 7: it follows whatever the rules say now.
        expect(txnOf(after, 'c7').import_payee_name).toBe('PADOCA 7');
        // New rows: Corner Shop is the rule's payee only where a rule says so.
        const rules = await Promise.all(['Bakery', 'Padaria', 'Uber'].map((p) => rulesOf(c, p)));
        const bakeryHasCorner = rules[0]!.some((r) => r.condition === 'Corner Shop');
        const fwd1 = txnOf(after, 'fwd1');
        expect(fwd1.payee_id).toBe(bakeryHasCorner ? c.idOf('Bakery') : after.payees.find((p) => p.name === 'Corner Shop')!.id);
        expect(fwd1.import_payee_name).toBe('Corner Shop');
        // The new texts are quiet from now on, and so is everything else.
        const again = await c.sync();
        expect(again).toMatchObject({ added: 0, updated: 0, failed: 0 });
        expect(((await c.snapshot()) as Snap).transactions).toEqual(after.transactions);
      });
    });
  }
}

describe.skipIf(!dbReady)('a post-change row follows the bank in date and amount but keeps its payee and import text', () => {
  test('a synced row stored under a rule keeps that payee when the rule goes and the bank moves its amount', async () => {
    const c = await build('keep', true);
    budgets.push(c.B);
    upstream = [...mainUpstream(), up('k1', 'PADOCA 77', -7700)];
    expect(await c.sync()).toMatchObject({ added: 1, updated: 0, failed: 0 });
    const first = (await c.snapshot()) as Snap;
    expect(txnOf(first, 'k1')).toMatchObject({ payee_id: c.idOf('Padaria'), import_payee_name: 'PADOCA 77' });
    for (const rule of await rulesOf(c, 'Padaria')) await op('budget_payees_rename_rules_remove', { id: c.idOf('Padaria'), budget_id: c.B, rule_id: rule.id });
    upstream = [...mainUpstream(), up('k1', 'PADOCA 77', -7800)];
    expect(await c.sync()).toMatchObject({ added: 0, updated: 1, failed: 0 });
    const after = (await c.snapshot()) as Snap;
    expect(txnOf(after, 'k1')).toMatchObject({ payee_id: c.idOf('Padaria'), import_payee_name: 'PADOCA 77', amount: '-7800' });
    expect(after.shadows.find((s) => s.transaction_id === txnOf(after, 'k1').id)!.last_synced_payload).toMatchObject({ payee: 'Padaria', amount: -7800 });
    expect(await c.sync()).toMatchObject({ added: 0, updated: 0, failed: 0 });
  });

  test('a statement row stored under a rule is still a duplicate once the rule is gone, and a new text is not', async () => {
    const c = await build('keepbulk', true);
    budgets.push(c.B);
    const row = { date, payee: 'PADOCA 88', memo: '', outflow: 8800, inflow: 0, category_id: null };
    expect(await c.bulk('Savings Conta', [row])).toEqual({ imported: 1, duplicates: 0 });
    for (const rule of await rulesOf(c, 'Padaria')) await op('budget_payees_rename_rules_remove', { id: c.idOf('Padaria'), budget_id: c.B, rule_id: rule.id });
    const names = async () => (await pool.query('SELECT name FROM payees WHERE budget_id = $1 ORDER BY name', [c.B])).rows;
    const payeesBefore = await names();
    expect(await c.bulk('Savings Conta', [row, row])).toEqual({ imported: 0, duplicates: 2 });
    expect(await c.bulk('Savings Conta', [{ ...row, payee: 'PADOCA 89', outflow: 8900 }])).toEqual({ imported: 1, duplicates: 0 });
    expect((await names()).length).toBe(payeesBefore.length + 1);
  });
});

describe.skipIf(!dbReady)('applying one rule to past transactions', () => {
  const revision = async (c: Ctx) => ((await op('budget_revision_get', { budget_id: c.B })).json as { revision: number }).revision;

  test('preview counts, apply changes exactly those rows (and nothing else), a sync and a re-import afterwards change nothing; revert puts it all back', async () => {
    const c = await build('apply', true);
    budgets.push(c.B);
    // Rows and texts the new rule will meet: stored under their own payee (as imported), plus an edited row (c0) and a reconciled one.
    expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).status).toBe(201);
    expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'starts_with', condition: 'Cafe' })).status).toBe(201);
    const rules = await rulesOf(c, 'Bakery');
    const corner = rules.find((r) => r.condition === 'Corner Shop')!;
    const cafe = rules.find((r) => r.condition === 'Cafe')!;
    // A statement row of the same text in another account, reconciled; and a categorised one is still changed (never its category).
    const cat = crypto.randomUUID();
    const group = crypto.randomUUID();
    await pool.query("INSERT INTO category_groups (id, budget_id, name) VALUES ($1,$2,'G')", [group, c.B]);
    await pool.query("INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1,$2,$3,'Cat')", [cat, c.B, group]);
    const shop = await pool.query<{ id: string }>('SELECT id FROM transactions WHERE budget_id = $1 AND import_payee_name = $2', [c.B, 'Corner Shop']);
    expect(shop.rowCount).toBeGreaterThan(0);
    await pool.query('UPDATE transactions SET category_id = $2 WHERE id = $1', [shop.rows[0]!.id, cat]);

    const before = (await c.snapshot()) as Snap;
    const rev0 = await revision(c);
    const preview = (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: corner.id })).json as { count: number; sample: { id: string; payee_name: string; bank_text: string; amount: number; date: string }[]; skipped: Record<string, number> };
    expect(await revision(c)).toBe(rev0);
    expect(preview.count).toBeGreaterThan(0);
    expect(preview.sample.length).toBeLessThanOrEqual(10);
    expect(preview.sample[0]).toMatchObject({ bank_text: 'Corner Shop', payee_name: 'Corner Shop' });
    expect(await c.snapshot()).toEqual(before);

    const result = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: corner.id })).json as { apply_id: string; changed: number; rows: { transaction_id: string; previous_payee_id: string | null; payee_id: string | null }[]; skipped: Record<string, number> };
    expect(result.changed).toBe(preview.count);
    expect(result.rows.map((r) => r.transaction_id).sort()).toEqual(expect.arrayContaining(preview.sample.map((s) => s.id)));
    expect(await revision(c)).toBe(rev0 + 1);
    const after = (await c.snapshot()) as Snap;
    const changedIds = new Set(result.rows.map((r) => r.transaction_id));
    for (const t of before.transactions) {
      const now = after.transactions.find((x) => x.id === t.id)!;
      if (changedIds.has(t.id)) expect({ ...now, payee_id: t.payee_id }, 'only the payee changes').toEqual(t);
      else expect(now).toEqual(t);
    }
    for (const r of result.rows) expect(after.transactions.find((x) => x.id === r.transaction_id)!.payee_id).toBe(c.idOf('Bakery'));
    expect(after.payees).toEqual(before.payees);
    // Categories untouched.
    expect(after.transactions.find((x) => x.id === shop.rows[0]!.id)!.category_id).toBe(cat);
    // The applied synced rows' shadows agree: the next sync neither blocks nor updates them.
    const applied = after.transactions.filter((t) => changedIds.has(t.id));
    for (const t of applied) {
      const shadow = after.shadows.find((s) => s.transaction_id === t.id);
      if (shadow) expect(shadow.last_synced_payload.payee).toBe('Bakery');
    }
    // A second apply finds nothing left to do.
    expect(((await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: corner.id })).json as { count: number }).count).toBe(0);
    // And the rows are quiet for sync and re-import, with the rule in place.
    await quiet2(c, after);

    // The edited row is never touched, even by a rule that matches its text.
    expect(txnOf(after, 'c0').payee_id).toBe(txnOf(before, 'c0').payee_id);

    // Revert: the budget is as it was.
    const revert = (await op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: result.apply_id })).json as { reverted: number; skipped: unknown[] };
    expect(revert).toEqual({ reverted: result.rows.length, skipped: [] });
    expect(await c.snapshot()).toEqual(before);
    // Reverting twice changes nothing: the rows are no longer as the apply left them.
    const twice = (await op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: result.apply_id })).json as { reverted: number; skipped: { reason: string }[] };
    expect(twice.reverted).toBe(0);
    expect(twice.skipped.every((s) => s.reason === 'already_reverted')).toBe(true);
    void cafe;
  });

  async function quiet2(c: Ctx, expected: Snap) {
    upstream = mainUpstream();
    for (let pass = 0; pass < 2; pass++) {
      expect(await c.sync()).toMatchObject({ added: 0, updated: 0, blocked: 1, failed: 0 });
      expect(await c.bulk('Savings Conta', plainRows())).toEqual({ imported: 0, duplicates: 24 });
      expect(await c.bulk('Cartao Conta', clientRows())).toEqual({ imported: 0, duplicates: 4 });
    }
    const now = (await c.snapshot()) as Snap;
    expect(now.transactions).toEqual(expected.transactions);
    expect(now.payees).toEqual(expected.payees);
    expect(now.hints).toEqual(expected.hints);
    expect(now.shadows.map((s) => s.last_synced_payload)).toEqual(expected.shadows.map((s) => s.last_synced_payload));
  }

  test('a row the person changed, a reconciled row and a row that is a transfer are left alone and counted', async () => {
    const c = await build('skips', true);
    budgets.push(c.B);
    const add = await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'contains', condition: 'UBER TRIP' });
    // (UBER TRIP is Uber's: add under another text instead.)
    expect(add.status).toBe(409);
    const ok = await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' });
    const rule = ok.json as { id: string };
    const row = (await pool.query<{ id: string }>("SELECT id FROM transactions WHERE budget_id = $1 AND import_payee_name = 'Corner Shop'", [c.B])).rows;
    expect(row.length).toBeGreaterThanOrEqual(1);
    const preview = async () => (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule.id })).json as { count: number; skipped: { edited: number; reconciled: number; transfer: number } };
    const base = await preview();
    expect(base.count).toBe(row.length);
    // The person picked another payee: edited. Reconciled: left alone. A transfer: left alone.
    const [first, ...rest] = row;
    await pool.query('UPDATE transactions SET payee_id = $2 WHERE id = $1', [first!.id, c.idOf('Cafe Central 1')]);
    expect(await preview()).toMatchObject({ count: base.count - 1, skipped: { edited: 1 } });
    if (rest[0]) {
      await pool.query("UPDATE transactions SET cleared = 'reconciled' WHERE id = $1", [rest[0].id]);
      expect(await preview()).toMatchObject({ skipped: { edited: 1, reconciled: 1 } });
    }
  });

  test('a rule on an account\'s transfer payee gives past rows a hint for the matcher (no mirror, no transfer payee) and leaves rows the bank rules refuse', async () => {
    const c = await build('xfer', true);
    budgets.push(c.B);
    const third = c.accounts['Third Conta']!;
    await pool.query("UPDATE accounts SET type = 'creditCard', account_group = 'CREDIT' WHERE id = $1", [c.accounts['Cartao Conta']]);
    // Two text rows imported BEFORE the rule: one into the checking account (Savings Conta), one outflow of the credit card.
    const mk = (payee: string, outflow: number) => ({ date, payee, memo: '', outflow, inflow: 0, category_id: null });
    expect(await c.bulk('Savings Conta', [mk('TED ZEZE 1', 31_000), mk('TED ZEZE 2', 32_000)])).toEqual({ imported: 2, duplicates: 0 });
    expect(await c.bulk('Cartao Conta', [mk('TED ZEZE 3', 33_000)])).toEqual({ imported: 1, duplicates: 0 });
    const added = (await op('budget_payees_rename_rules_add', { id: c.idOf('Transfer : Third Conta'), budget_id: c.B, match_type: 'contains', condition: 'TED ZEZE' })).json as { id: string };
    const before = (await c.snapshot()) as Snap;
    const txCount = before.transactions.length;
    // The rule is on the books but changed nothing by itself.
    expect(before.hints.some((h) => h.account_id === third && before.transactions.find((t) => t.id === h.transaction_id)?.import_payee_name?.startsWith('TED ZEZE'))).toBe(false);
    const preview = (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Transfer : Third Conta'), budget_id: c.B, rule_id: added.id })).json as { count: number; skipped: { bank_rules: number } };
    expect(preview.count).toBe(2);
    expect(preview.skipped.bank_rules).toBe(1); // a card is never the outflow side of a transfer
    const result = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Transfer : Third Conta'), budget_id: c.B, rule_id: added.id })).json as { apply_id: string; changed: number; rows: { transaction_id: string; hint_account_id: string | null; payee_id: string | null; previous_payee_id: string | null }[] };
    expect(result.changed).toBe(2);
    const after = (await c.snapshot()) as Snap;
    expect(after.transactions).toHaveLength(txCount); // no mirror rows
    expect(after.payees).toEqual(before.payees); // no new payee: the ordinary payee of the text already existed
    for (const r of result.rows) {
      expect(r.hint_account_id).toBe(third);
      expect(r.payee_id).toBe(r.previous_payee_id); // the row keeps the ordinary payee of its text, never the transfer payee
      expect(after.hints.find((h) => h.transaction_id === r.transaction_id)?.account_id).toBe(third);
      const t = after.transactions.find((x) => x.id === r.transaction_id)!;
      expect(t.payee_id).not.toBe(c.idOf('Transfer : Third Conta'));
    }
    expect(after.hints.filter((h) => h.account_id === third)).toHaveLength(before.hints.filter((h) => h.account_id === third).length + 2);
    // Statement re-import afterwards: still all duplicates.
    expect(await c.bulk('Savings Conta', [mk('TED ZEZE 1', 31_000), mk('TED ZEZE 2', 32_000)])).toEqual({ imported: 0, duplicates: 2 });
    expect(await c.bulk('Cartao Conta', [mk('TED ZEZE 3', 33_000)])).toEqual({ imported: 0, duplicates: 1 });
    // Revert drops the hints again.
    expect(((await op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: result.apply_id })).json as { reverted: number }).reverted).toBe(2);
    expect(await c.snapshot()).toEqual(before);
  });

  test('a rule or a payee of another budget is a 404', async () => {
    const c = await build('foreign', true);
    budgets.push(c.B);
    const other = await build('foreign2', true);
    budgets.push(other.B);
    const [rule] = await rulesOf(other, 'Uber');
    expect((await op('budget_payees_rename_rules_apply', { id: c.idOf('Uber'), budget_id: c.B, rule_id: rule!.id })).status).toBe(404);
    expect((await op('budget_payees_rename_rules_apply_preview', { id: other.idOf('Uber'), budget_id: c.B, rule_id: rule!.id })).status).toBe(404);
  });
});

async function buildWith(label: string, raw: StoredRaw): Promise<Ctx> {
  storedRaw = raw;
  try {
    const c = await build(label, true);
    budgets.push(c.B);
    return c;
  } finally {
    storedRaw = 'text';
  }
}

describe.skipIf(!dbReady)('rows stored before rules assigned their payee: the bank only moved the date or the amount (F1)', () => {
  for (const raw of ['text', 'none', 'null'] as const) {
    test(`the row follows the bank and keeps its payee, import name and shadow whatever the rules say now (stored provider object: ${raw})`, async () => {
      const c = await buildWith(`f1${raw}`, raw);
      // "MERCADO LIVRE SP" (c9) was stored by main as the spliced payee "Mercadoado livre sp"; take the rules that spliced it away.
      for (const payee of ['Mercado', 'Mercado Livre']) {
        for (const rule of await rulesOf(c, payee)) await op('budget_payees_rename_rules_remove', { id: c.idOf(payee), budget_id: c.B, rule_id: rule.id });
      }
      const before = (await c.snapshot()) as Snap;
      upstream = mainUpstream().map((t) => (t.externalId === 'c9' ? { ...t, amount: -9700 } : t));
      expect(await c.sync()).toMatchObject({ added: 0, updated: 1, failed: 0 });
      const after = (await c.snapshot()) as Snap;
      const was = txnOf(before, 'c9');
      const now = txnOf(after, 'c9');
      expect(now).toMatchObject({ payee_id: was.payee_id, import_payee_name: 'Mercadoado livre sp', amount: '-9700' });
      expect(after.payees).toEqual(before.payees);
      expect(after.shadows.find((s) => s.transaction_id === now.id)!.last_synced_payload).toMatchObject({ payee: 'Mercadoado livre sp', amount: -9700 });
      upstream = mainUpstream().map((t) => (t.externalId === 'c9' ? { ...t, amount: -9700 } : t));
      expect(await c.sync()).toMatchObject({ added: 0, updated: 0, failed: 0 });
    });
  }

  test('a text the bank really changed takes the current rules, also for a row of the earlier form (the text is known from the stored provider object)', async () => {
    const c = await buildWith('f1changed', 'text');
    upstream = mainUpstream().map((t) => (t.externalId === 'c9' ? { ...t, description: 'MERCADO PAGO 1', raw: { id: 'c9', description: 'MERCADO PAGO 1', ...volatile() } } : t));
    expect(await c.sync()).toMatchObject({ added: 0, updated: 1, failed: 0 });
    const row = (await pool.query('SELECT p.name AS payee, t.import_payee_name FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE t.budget_id = $1 AND t.import_id = $2', [c.B, `${PROVIDER}:c9`])).rows[0];
    expect(row).toEqual({ payee: 'Mercado', import_payee_name: 'MERCADO PAGO 1' }); // rule "contains MERC" -> Mercado
  });
});

describe.skipIf(!dbReady)('apply matches the REAL bank text (B2)', () => {
  const apply = async (c: Ctx, payee: string, ruleId: string) => (await op('budget_payees_rename_rules_apply', { id: c.idOf(payee), budget_id: c.B, rule_id: ruleId })).json as { apply_id: string; changed: number; rows: { transaction_id: string }[]; skipped: Record<string, number> };
  const preview = async (c: Ctx, payee: string, ruleId: string) => (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf(payee), budget_id: c.B, rule_id: ruleId })).json as { count: number; sample: { bank_text: string; payee_name: string }[]; skipped: Record<string, number> };
  const addRule = async (c: Ctx, payee: string, type: string, condition: string) => ((await op('budget_payees_rename_rules_add', { id: c.idOf(payee), budget_id: c.B, match_type: type, condition })).json as { id: string }).id;

  test('a rule that matches only the rewritten import name of a legacy synced row does not match the row', async () => {
    const c = await buildWith('b2name', 'text');
    // The synced row "NETFLIX.COM" was stored by main as the payee and import name "Netflix"; the bank text is NETFLIX.COM.
    const rule = await addRule(c, 'Bakery', 'is', 'Netflix');
    const p = await preview(c, 'Bakery', rule);
    expect(p.sample.find((x) => x.bank_text === 'Netflix' && x.payee_name === 'Netflix')).toBeUndefined();
    const synced = (await pool.query("SELECT t.id FROM transactions t WHERE t.budget_id = $1 AND t.import_id LIKE $2 AND t.import_payee_name = 'Netflix'", [c.B, `${PROVIDER}:%`])).rows;
    expect(synced.length).toBeGreaterThan(0);
    const before = (await c.snapshot()) as Snap;
    const result = await apply(c, 'Bakery', rule);
    expect(result.rows.map((r) => r.transaction_id)).not.toEqual(expect.arrayContaining([synced[0].id]));
    const after = (await c.snapshot()) as Snap;
    for (const r of synced) expect(after.transactions.find((t) => t.id === r.id)!.payee_id).toBe(before.transactions.find((t) => t.id === r.id)!.payee_id);
  });

  for (const raw of ['text', 'none', 'null'] as const) {
    test(`apply on legacy synced rows changes what it reports, shows the real text, and two syncs and two re-imports change nothing afterwards (stored provider object: ${raw})`, async () => {
      const c = await buildWith(`b2${raw}`, raw);
      // The rule of Netflix goes; another payee takes "is NETFLIX.COM" for the past too.
      for (const rule of await rulesOf(c, 'Netflix')) await op('budget_payees_rename_rules_remove', { id: c.idOf('Netflix'), budget_id: c.B, rule_id: rule.id });
      const rule = await addRule(c, 'Bakery', 'is', 'NETFLIX.COM');
      const p = await preview(c, 'Bakery', rule);
      for (const s of p.sample) expect(s.bank_text).toBe('NETFLIX.COM'); // the real text, never "Netflix"
      if (raw === 'text') expect(p.sample.some((s) => s.payee_name === 'Netflix')).toBe(true);
      else expect(p.skipped.unknown_text).toBeGreaterThan(0);
      const before = (await c.snapshot()) as Snap;
      const result = await apply(c, 'Bakery', rule);
      expect(result.changed).toBe(p.count);
      expect(result.skipped.unknown_text).toBe(p.skipped.unknown_text);
      const after = (await c.snapshot()) as Snap;
      const moved = new Set(result.rows.map((r) => r.transaction_id));
      for (const t of before.transactions) if (!moved.has(t.id)) expect(after.transactions.find((x) => x.id === t.id)).toEqual(t);
      // Quiet from now on, for synced rows (the provider object changes on every pull) and statement re-imports alike.
      for (let pass = 0; pass < 2; pass++) {
        upstream = mainUpstream();
        expect(await c.sync(), `sync ${pass}`).toMatchObject({ added: 0, updated: 0, blocked: 1, failed: 0, duplicates: 23 });
        expect(await c.bulk('Savings Conta', plainRows()), `bulk ${pass}`).toEqual({ imported: 0, duplicates: 24 });
        expect(await c.bulk('Cartao Conta', clientRows()), `client ${pass}`).toEqual({ imported: 0, duplicates: 4 });
      }
      const quietAfter = (await c.snapshot()) as Snap;
      expect(quietAfter.transactions).toEqual(after.transactions);
      expect(quietAfter.payees).toEqual(after.payees);
      expect(quietAfter.shadows.map((s) => s.last_synced_payload)).toEqual(after.shadows.map((s) => s.last_synced_payload));
      if (raw !== 'text') {
        // The sync recorded the text it saw: the rows that could not be checked before can be now.
        const later = await preview(c, 'Bakery', rule);
        expect(later.skipped.unknown_text).toBe(0);
        expect(later.count).toBeGreaterThan(0);
      }
    });
  }
});

describe.skipIf(!dbReady)('revert takes only the id of a recorded apply (B3)', () => {
  const setup = async (label: string) => {
    const c = await buildWith(label, 'text');
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).json as { id: string }).id;
    const result = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { apply_id: string; rows: { transaction_id: string; payee_id: string | null; previous_payee_id: string | null }[] };
    expect(result.rows.length).toBeGreaterThan(0);
    return { c, rule, result };
  };
  const revert = (c: Ctx, body: Record<string, unknown>) => op('budget_payees_rename_rules_revert', { budget_id: c.B, ...body });

  test('a body of rows (the old shape) names nothing: it is refused, and nothing moves', async () => {
    const { c, result } = await setup('b3forge');
    const before = await c.snapshot();
    const forged = { rows: [{ transaction_id: result.rows[0]!.transaction_id, previous_payee_id: c.idOf('Transfer : Nubank Conta'), payee_id: result.rows[0]!.payee_id, previous_hint_account_id: null, hint_account_id: null }] };
    expect((await revert(c, forged)).status).toBe(400);
    expect(await c.snapshot()).toEqual(before);
  });

  test('the id of another budget\'s apply, or an unknown one, is a 404', async () => {
    const a = await setup('b3a');
    const b = await setup('b3b');
    expect((await revert(a.c, { apply_id: b.result.apply_id })).status).toBe(404);
    expect((await revert(a.c, { apply_id: crypto.randomUUID() })).status).toBe(404);
  });

  test('rows changed or frozen since the apply are left alone and reported; the rest is restored; a second revert restores nothing', async () => {
    const { c, result } = await setup('b3since');
    const ids = result.rows.map((r) => r.transaction_id);
    expect(ids.length).toBeGreaterThanOrEqual(1);
    // The person gives the first row another payee; the matcher/person reconcile another (when there is one).
    await pool.query('UPDATE transactions SET payee_id = $2 WHERE id = $1', [ids[0], c.idOf('Cafe Central 1')]);
    if (ids[1]) await pool.query("UPDATE transactions SET cleared = 'reconciled' WHERE id = $1", [ids[1]]);
    const out = (await revert(c, { apply_id: result.apply_id })).json as { reverted: number; skipped: { transaction_id: string; reason: string }[] };
    expect(out.skipped.map((x) => x.transaction_id)).toContain(ids[0]);
    expect(out.skipped.find((x) => x.transaction_id === ids[0])!.reason).toBe('changed_since');
    if (ids[1]) expect(out.skipped.find((x) => x.transaction_id === ids[1])!.reason).toBe('changed_since');
    expect(out.reverted).toBe(ids.length - out.skipped.length);
    const rows = (await pool.query<{ id: string; payee_id: string | null }>('SELECT id, payee_id FROM transactions WHERE id = ANY($1)', [ids])).rows;
    expect(rows.find((r) => r.id === ids[0])!.payee_id).toBe(c.idOf('Cafe Central 1'));
    const again = (await revert(c, { apply_id: result.apply_id })).json as { reverted: number };
    expect(again.reverted).toBe(0);
  });

  test('a previous payee that is gone is not put back (and never a transfer payee)', async () => {
    const { c, result } = await setup('b3gone');
    const previous = [...new Set(result.rows.map((r) => r.previous_payee_id).filter((x): x is string => x !== null))];
    await pool.query('UPDATE payees SET deleted = true WHERE id = ANY($1)', [previous]);
    const out = (await revert(c, { apply_id: result.apply_id })).json as { reverted: number; skipped: { reason: string }[] };
    expect(out.skipped.every((x) => x.reason === 'payee_gone')).toBe(true);
    expect(out.reverted).toBe(result.rows.filter((r) => r.previous_payee_id === null).length);
  });
});

describe.skipIf(!dbReady)('statement import with no rule change: another case is another text (B4)', () => {
  test('"Coffee Shop" then "COFFEE SHOP" (same date and amount) imports both; the same text again imports none', async () => {
    const c = await buildWith('b4', 'text');
    const row = (payee: string) => ({ date, payee, memo: '', outflow: 4_500, inflow: 0, category_id: null });
    expect(await c.bulk('Savings Conta', [row('Coffee Shop')])).toEqual({ imported: 1, duplicates: 0 });
    expect(await c.bulk('Savings Conta', [row('COFFEE SHOP')])).toEqual({ imported: 1, duplicates: 0 });
    expect(await c.bulk('Savings Conta', [row('COFFEE  SHOP')])).toEqual({ imported: 1, duplicates: 0 });
    expect(await c.bulk('Savings Conta', [row('Coffee Shop'), row('COFFEE SHOP'), row(' Coffee Shop ')])).toEqual({ imported: 0, duplicates: 3 });
  });
});

describe.skipIf(!dbReady)('the recorded bank text is the text of the latest pull (round 3, N1 + N2)', () => {
  const textOf = async (c: Ctx, ext: string) => (await pool.query<{ bank_text: string | null }>('SELECT cs.bank_text FROM connection_transactions cs JOIN transactions t ON t.id = cs.transaction_id WHERE t.budget_id = $1 AND t.import_id = $2', [c.B, `${PROVIDER}:${ext}`])).rows[0]!.bank_text;
  const pull = (texts: Record<string, string>, extra: { id: string; text: string; amount: number }[]) => {
    const base = mainUpstream().map((t) => (texts[t.externalId] ? { ...t, description: texts[t.externalId]!, raw: { ...t.raw, description: texts[t.externalId]! } } : t));
    return [...base, ...extra.map((e) => up(e.id, e.text, e.amount))];
  };
  const sync2 = async (c: Ctx, extra: { id: string; text: string; amount: number }[]) => {
    for (let i = 0; i < 2; i++) {
      upstream = pull({}, extra);
      expect(await c.sync(), `sync ${i}`).toMatchObject({ added: 0, updated: 0, failed: 0 });
    }
  };

  test('pending -> posted keeps the payee; the text is recorded on that duplicate pull; a later rule edit and rule add re-point nothing', async () => {
    const c = await buildWith('n1', 'text');
    upstream = pull({}, [{ id: 'n1', text: 'UBER TRIP PENDING', amount: -1100 }]);
    expect(await c.sync()).toMatchObject({ added: 1, failed: 0 });
    expect(await textOf(c, 'n1')).toBe('UBER TRIP PENDING');
    // The bank posts it: the text changes to one that still resolves to the same payee (Uber, contains "UBER TRIP").
    const posted = [{ id: 'n1', text: 'UBER TRIP', amount: -1100 }];
    upstream = pull({}, posted);
    expect(await c.sync()).toMatchObject({ added: 0, updated: 0, failed: 0 });
    expect(await textOf(c, 'n1')).toBe('UBER TRIP'); // not the stale "UBER TRIP PENDING"
    const before = (await c.snapshot()) as Snap;
    const [uber] = await rulesOf(c, 'Uber');
    expect((await op('budget_payees_rename_rules_update', { id: c.idOf('Uber'), budget_id: c.B, rule_id: uber!.id, match_type: 'contains', condition: 'UBER EATS' })).status).toBe(200);
    expect((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'UBER TRIP' })).status).toBe(201);
    await sync2(c, posted);
    const after = (await c.snapshot()) as Snap;
    expect(txnOf(after, 'n1')).toEqual(txnOf(before, 'n1'));
    expect(after.payees).toEqual(before.payees);
    expect(after.shadows).toEqual(before.shadows);
  });

  test('preview and apply match the posted text, and the next syncs leave the applied row alone', async () => {
    const c = await buildWith('n2', 'text');
    upstream = pull({}, [{ id: 'n2', text: 'UBER TRIP PENDING', amount: -1200 }]);
    await c.sync();
    const posted = [{ id: 'n2', text: 'UBER TRIP', amount: -1200 }];
    upstream = pull({}, posted);
    await c.sync();
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'UBER TRIP' })).json as { id: string }).id;
    const p = (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { count: number; sample: { bank_text: string }[] };
    expect(p.count).toBe(1);
    expect(p.sample[0]!.bank_text).toBe('UBER TRIP');
    const r = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { changed: number };
    expect(r.changed).toBe(1);
    const applied = (await c.snapshot()) as Snap;
    expect(txnOf(applied, 'n2').payee_id).toBe(c.idOf('Bakery'));
    await sync2(c, posted);
    expect(((await c.snapshot()) as Snap).transactions).toEqual(applied.transactions);
  });

  test('even if the recorded text were stale, the stored provider object (the bank\'s own words) decides', async () => {
    const c = await buildWith('n2raw', 'text');
    upstream = pull({}, [{ id: 'n2', text: 'UBER TRIP', amount: -1300 }]);
    await c.sync();
    await pool.query("UPDATE connection_transactions SET bank_text = 'SOMETHING OLD' WHERE external_transaction_id = 'n2' AND budget_id = $1", [c.B]);
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'UBER TRIP' })).json as { id: string }).id;
    const p = (await op('budget_payees_rename_rules_apply_preview', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { count: number; sample: { bank_text: string }[] };
    expect(p.count).toBe(1);
    expect(p.sample[0]!.bank_text).toBe('UBER TRIP');
  });
});

describe.skipIf(!dbReady)('an apply is reverted once; revert restores the payee and hint only (round 3, F1 + F5)', () => {
  const addRule = async (c: Ctx, text: string) => ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: text })).json as { id: string }).id;
  const applyOp = async (c: Ctx, rule: string) => (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { apply_id: string; changed: number; rows: { transaction_id: string }[] };
  const revertOp = async (c: Ctx, apply: string) => (await op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: apply })).json as { reverted: number; skipped: { reason: string }[] };

  test('apply1 -> revert1 -> apply2 -> revert1 again (nothing) -> revert2 (restores)', async () => {
    const c = await buildWith('f1', 'text');
    const rule = await addRule(c, 'Corner Shop');
    const original = (await c.snapshot()) as Snap;
    const a1 = await applyOp(c, rule);
    expect(a1.changed).toBeGreaterThan(0);
    expect((await revertOp(c, a1.apply_id)).reverted).toBe(a1.changed);
    expect(await c.snapshot()).toEqual(original);
    const a2 = await applyOp(c, rule);
    expect(a2.changed).toBe(a1.changed);
    const applied = (await c.snapshot()) as Snap;
    const again = await revertOp(c, a1.apply_id);
    expect(again.reverted).toBe(0);
    expect(again.skipped.length).toBe(a1.changed);
    expect(again.skipped.every((x) => x.reason === 'already_reverted')).toBe(true);
    expect(await c.snapshot()).toEqual(applied);
    expect((await revertOp(c, a2.apply_id)).reverted).toBe(a2.changed);
    expect(await c.snapshot()).toEqual(original);
  });

  test('a category, memo or approval changed after the apply stays as the person left it', async () => {
    const c = await buildWith('f5', 'text');
    const rule = await addRule(c, 'Corner Shop');
    const a = await applyOp(c, rule);
    const id = a.rows[0]!.transaction_id;
    const cat = crypto.randomUUID();
    const group = crypto.randomUUID();
    await pool.query("INSERT INTO category_groups (id, budget_id, name) VALUES ($1,$2,'G5')", [group, c.B]);
    await pool.query("INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1,$2,$3,'Cat5')", [cat, c.B, group]);
    await pool.query("UPDATE transactions SET category_id = $2, memo = 'mine', approved = true WHERE id = $1", [id, cat]);
    expect((await revertOp(c, a.apply_id)).reverted).toBe(a.changed);
    const row = (await pool.query('SELECT payee_id, category_id, memo, approved FROM transactions WHERE id = $1', [id])).rows[0];
    expect(row).toMatchObject({ category_id: cat, memo: 'mine', approved: true });
    expect(row.payee_id).not.toBe(c.idOf('Bakery'));
  });
});

describe.skipIf(!dbReady)('apply, revert and the sync share a per-budget lock; apply reads and locks only the rows the rule can match (round 3, F2 + F3)', () => {
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const settled = async (p: Promise<unknown>) => (await Promise.race([p.then(() => true), wait(400).then(() => false)])) as boolean;

  test('an apply and a revert hold the budget lock exclusively: a sync, another apply and a revert wait for them, and run once it is released', async () => {
    const c = await buildWith('f2', 'text');
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).json as { id: string }).id;
    const applied = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { apply_id: string };
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await lockBudgetImportWrites(holder, [c.B], 'exclusive');
      upstream = mainUpstream();
      const sync = c.sync();
      const apply = op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule });
      const revert = op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: applied.apply_id });
      expect(await settled(sync), 'sync waits').toBe(false);
      expect(await settled(apply), 'apply waits').toBe(false);
      expect(await settled(revert), 'revert waits').toBe(false);
      await holder.query('COMMIT');
      await Promise.all([sync, apply, revert]);
    } finally {
      holder.release();
    }
  });

  test('syncs hold the budget lock SHARED: two connections of one budget sync together while a sync holds it; an apply and a revert wait for them', async () => {
    const c = await buildWith('l1', 'text');
    // A second connection with its own (empty) account in the same budget.
    const second = await store.upsertConnection({ userId: user.id, provider: PROVIDER, externalId: `up-item-forward-l1b-${user.id}`, clientUserId: `cu-${user.id}-l1b`, status: 'connected', environment: 'production' });
    const acc2 = crypto.randomUUID();
    await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget, connection_id, external_account_id) VALUES ($1,$2,'Second Conta','checking','CASH',true,$3,'up-acc-forward-second')`, [acc2, c.B, second.id]);
    const sync2 = () => syncConnectionTransactions({ userId: user.id, connectionId: second.id, aggregator, ignoreWatermark: true });
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).json as { id: string }).id;
    const applied = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { apply_id: string };
    // A session that holds the lock the way a running sync does (shared, to COMMIT).
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await lockBudgetImportWrites(holder, [c.B], 'shared');
      upstream = mainUpstream();
      // Two syncs of one budget run in parallel with it: neither waits for the other or for the holder.
      const both = Promise.all([c.sync(), sync2()]);
      expect(await settled(both), 'two syncs of one budget do not wait for each other').toBe(true);
      // An apply and a revert wait for the running sync.
      const apply = op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule });
      const revert = op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: applied.apply_id });
      expect(await settled(apply), 'apply waits for a running sync').toBe(false);
      expect(await settled(revert), 'revert waits for a running sync').toBe(false);
      await holder.query('COMMIT');
      await Promise.all([apply, revert]);
    } finally {
      holder.release();
    }
  });

  test('an apply or a revert that cannot get the lock in time answers 409 bank_sync_running, and writes nothing', async () => {
    const c = await buildWith('l2', 'text');
    const rule = ((await op('budget_payees_rename_rules_add', { id: c.idOf('Bakery'), budget_id: c.B, match_type: 'is', condition: 'Corner Shop' })).json as { id: string }).id;
    const done = (await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule })).json as { apply_id: string };
    const before = await c.snapshot();
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await lockBudgetImportWrites(holder, [c.B], 'shared');
      const t0 = Date.now();
      const apply = await op('budget_payees_rename_rules_apply', { id: c.idOf('Bakery'), budget_id: c.B, rule_id: rule });
      const revert = await op('budget_payees_rename_rules_revert', { budget_id: c.B, apply_id: done.apply_id });
      expect(Date.now() - t0).toBeLessThan(15_000);
      for (const res of [apply, revert]) {
        expect(res.status).toBe(409);
        expect(res.json).toMatchObject({ code: 'bank_sync_running' });
      }
      await holder.query('COMMIT');
    } finally {
      holder.release();
    }
    expect(await c.snapshot()).toEqual(before);
  }, 30_000);

  test('the SQL prefilter trims like JavaScript: a raw text with a tab, a newline or a no-break space at an end is still found', async () => {
    const c = await buildWith('l3', 'text');
    const texts = ['\tPIX ZETA 1\n', '\u00a0PIX ZETA 2\u00a0', 'PIX ZETA 3\r\n', '\ufeffPIX ZETA 4'];
    await pool.query('UPDATE connection_transactions SET raw_payload = jsonb_set(raw_payload, \'{description}\', to_jsonb($2::text)) WHERE budget_id = $1 AND external_transaction_id = $3', [c.B, texts[0], 'c1']);
    await pool.query('UPDATE connection_transactions SET raw_payload = jsonb_set(raw_payload, \'{description}\', to_jsonb($2::text)) WHERE budget_id = $1 AND external_transaction_id = $3', [c.B, texts[1], 'c2']);
    await pool.query('UPDATE connection_transactions SET raw_payload = jsonb_set(raw_payload, \'{description}\', to_jsonb($2::text)) WHERE budget_id = $1 AND external_transaction_id = $3', [c.B, texts[2], 'c3']);
    await pool.query('UPDATE connection_transactions SET raw_payload = jsonb_set(raw_payload, \'{description}\', to_jsonb($2::text)) WHERE budget_id = $1 AND external_transaction_id = $3', [c.B, texts[3], 'c4']);
    for (const type of ['is', 'starts_with', 'ends_with'] as const) {
      const condition = type === 'is' ? 'PIX ZETA 1' : type === 'starts_with' ? 'PIX ZETA' : 'ZETA 2';
      const rows = await listApplyRows(pool, c.B, { match_type: type, condition });
      const found = new Set(rows.map((r) => r.bank_text));
      if (type === 'is') expect(found.has('PIX ZETA 1')).toBe(true);
      if (type === 'starts_with') for (const t of ['PIX ZETA 1', 'PIX ZETA 2', 'PIX ZETA 3', 'PIX ZETA 4']) expect(found.has(t), `${type} ${t}`).toBe(true);
      if (type === 'ends_with') expect(found.has('PIX ZETA 2')).toBe(true);
    }
  });

  test('apply locks only the rows the rule can match, and reads fewer rows than the budget imported', async () => {
    const c = await buildWith('f3', 'text');
    const all = (await pool.query("SELECT id, import_payee_name FROM transactions WHERE budget_id = $1 AND import_id IS NOT NULL AND NOT deleted", [c.B])).rows as { id: string; import_payee_name: string }[];
    const corner = all.find((r) => r.import_payee_name === 'Corner Shop')!;
    const other = all.find((r) => r.import_payee_name !== 'Corner Shop' && !/corner/i.test(r.import_payee_name))!;
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      const rows = await listApplyRows(holder, c.B, { match_type: 'is', condition: 'Corner Shop' }, true);
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThan(all.length / 2);
      const nowait = async (id: string) => pool.query('SELECT 1 FROM transactions WHERE id = $1 FOR UPDATE NOWAIT', [id]).then(() => 'free', () => 'locked');
      expect(await nowait(other.id)).toBe('free');
      expect(await nowait(corner.id)).toBe('locked');
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    // A pattern with a non-ASCII character is not prefiltered (lower() is locale dependent in SQL): it reads every imported row.
    const wide = await listApplyRows(pool, c.B, { match_type: 'contains', condition: 'cafÉ' });
    expect(wide.length).toBeGreaterThanOrEqual(all.length - 5);
    const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE tablename = 'rename_rule_apply_rows' AND indexdef LIKE '%(transaction_id)%'");
    expect(idx.rowCount).toBeGreaterThan(0);
  });
});

describe.skipIf(!dbReady)('re-importing main\'s statement files into a fresh-start copy (round 3, F6)', () => {
  test('imports nothing now (the carried rows are recognised by amount, date and text, whatever payee ids their keys name); main imported every row again', async () => {
    const c = await buildWith('f6', 'text');
    // (A linked account's copy would collide with the original on the link's unique index: unlink it, the copied rows carry no shadow anyway.)
    await pool.query('UPDATE accounts SET connection_id = NULL, external_account_id = NULL WHERE budget_id = $1', [c.B]);
    const res = (await op('budget_fresh_start', { budget_id: c.B })).json as { created: { id: string } };
    budgets.push(res.created.id);
    const accounts = (await pool.query<{ id: string; name: string }>('SELECT id, name FROM accounts WHERE budget_id = $1', [res.created.id])).rows;
    // Fresh start carries the history of LINKED accounts only, copying each row with the new budget's payee and account ids and
    // its import id untouched (the key still names the OLD payee's id). The statement accounts here are not linked (a linked copy
    // collides with the original on the link's unique index), so the carry-over is reproduced as it does it.
    await pool.query(
      `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted, import_id, import_payee_name, import_payee_name_original)
       SELECT $2, na.id, t.date, t.amount, np.id, t.cleared, t.approved, t.repeat, false, t.import_id, t.import_payee_name, t.import_payee_name_original
         FROM transactions t
         JOIN accounts oa ON oa.id = t.account_id AND oa.name IN ('Savings Conta', 'Cartao Conta')
         JOIN accounts na ON na.budget_id = $2 AND na.name = oa.name
         LEFT JOIN payees op ON op.id = t.payee_id
         LEFT JOIN payees np ON np.budget_id = $2 AND np.name = op.name
        WHERE t.budget_id = $1 AND NOT t.deleted`,
      [c.B, res.created.id],
    );
    const copied = (await pool.query('SELECT count(*)::int AS n FROM transactions WHERE budget_id = $1', [res.created.id])).rows[0].n as number;
    expect(copied).toBe(28);
    const into = async (name: string, rows: object[]) => (await op('budget_transactions_bulk_import', { budget_id: res.created.id, account_id: accounts.find((a) => a.name === name)!.id, txns: rows })).json as { imported: number; duplicates: number };
    expect(await into('Savings Conta', plainRows())).toEqual({ imported: 0, duplicates: 24 });
    expect(await into('Cartao Conta', clientRows())).toEqual({ imported: 0, duplicates: 4 });
  });
});
