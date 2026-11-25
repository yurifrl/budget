/**
 * Rows imported under the earlier renaming behaviour (budget-mkrt, transfers T3b).
 *
 * Until a matching rule ASSIGNED its payee, a `contains` rule rewrote only the
 * matching part of the text ("PIX SAV 42" -> "Transfer : Nubank Conta 42", "PADOCA 42"
 * -> "Padaria 42") and that rewritten text was stored as an ordinary payee. Those rows
 * are in the database, next to texts with double spaces, rules whose patterns differ only
 * by case or by spacing, overlapping rules, and rows the person edited. This file proves
 * they stay as they are, with the rules read from the payee columns (as main left them),
 * both through migration 0121 and straight from the columns:
 *  - a bank sync and a statement re-import of the same data (as main stored it) change,
 *    duplicate and skip nothing and create no payee; import keys and dedupe stay;
 *  - the new behaviour applies to rows INSERTED from now on and to rows the bank actually
 *    changes, and only to those.
 *
 * The expected state is NOT computed by this branch's code: testdata/main-rename-capture.json
 * was recorded by running main (f538f3f) on the same data (script: testdata/capture-main-rename.ts.txt)
 * and the rows below are written literally from it before this branch's code runs.
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

const PROVIDER = 'testprovider-capture';
const user: IdentityUser = { id: crypto.randomUUID(), email: 'rules-legacy@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const EXT_ITAU = 'up-acc-legacy-itau';
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
const ACCOUNT_NAMES = ['Itau Conta', 'Nubank Conta', 'Third Conta', 'Savings Conta', 'Cartao Conta'];

let upstream: AggregatedTransaction[] = [];
let activeUser = user.id;
const aggregator = {
  environment: 'production',
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
const up = (externalId: string, description: string, amount: number): AggregatedTransaction => ({
  externalId,
  externalAccountId: EXT_ITAU,
  description,
  amount,
  date,
  currencyCode: null,
  cleared: true,
  raw: { id: externalId },
});
const mainUpstream = () => fx.texts.map(([text, amount], i) => up(`c${i}`, text, amount));
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
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [B, `rules-legacy-${label}`, user.id]);
  await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [B, user.id]);
  for (const [name, id] of Object.entries(accounts)) {
    await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$2,$3,'checking','CASH',true)`, [id, B, name]);
  }
  const conn = await store.upsertConnection({ userId: user.id, provider: PROVIDER, externalId: `up-item-legacy-${label}-${user.id}`, clientUserId: `cu-${user.id}-${label}`, status: 'connected', environment: 'production' });
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
      [id, B, PROVIDER, r.external_id, JSON.stringify({ date, amount: r.amount, memo: '', payee: r.shadow_payee }), r.blocked, JSON.stringify({ id: r.external_id })],
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

describe.skipIf(!dbReady)('the capture is what main did', () => {
  test('main had every row duplicate on its second pass, kept the edited row blocked, and spliced the payees', () => {
    expect(fx.main_results.sync2).toMatchObject({ added: 0, updated: 0, duplicates: 23, blocked: 1 });
    expect(fx.main_results.bulk2).toEqual({ imported: 0, duplicates: 24 });
    expect(fx.main_results.client2).toEqual({ imported: 0, duplicates: 4 });
    const payees = fx.sync_rows.map((r) => r.payee);
    for (const spliced of ['Transfer : Nubank Conta 42', 'Casa Old 1', 'Casa New 2', 'UBER  TRIP 9', 'Mercadoado livre sp', 'Uber 123']) expect(payees).toContain(spliced);
    expect(fx.sync_rows.find((r) => r.external_id === 'c0')).toMatchObject({ payee: 'Edited Payee', blocked: true });
  });
});

for (const migrate of [true, false]) {
  describe.skipIf(!dbReady)(`rows main stored stay as they are (${migrate ? 'rules copied by migration 0121' : 'rules read from the payee columns'})`, () => {
    let c: Ctx;
    beforeAll(async () => {
      c = await build(migrate ? 'm' : 'c', migrate);
      budgets.push(c.B);
    });

    test('a bank sync of data main stored changes, creates and skips nothing, twice', async () => {
      upstream = mainUpstream();
      const before = await c.snapshot();
      const first = await c.sync();
      const second = await c.sync();
      expect(first).toMatchObject({ added: 0, updated: 0, deleted: 0, blocked: 1, failed: 0, duplicates: 23 });
      expect(second).toMatchObject({ added: 0, updated: 0, deleted: 0, blocked: 1, failed: 0, duplicates: 23 });
      // Rows, shadows, hints, payees and balances are identical (only the raw payload refresh is outside the snapshot).
      expect(await c.snapshot()).toEqual(before);
    });

    test('a statement re-import of data main stored duplicates and creates nothing: same keys, same dedupe, bank text and client-style rows alike', async () => {
      const before = await c.snapshot();
      expect(await c.bulk('Savings Conta', plainRows())).toEqual({ imported: 0, duplicates: 24 });
      expect(await c.bulk('Savings Conta', plainRows())).toEqual({ imported: 0, duplicates: 24 });
      expect(await c.bulk('Cartao Conta', clientRows())).toEqual({ imported: 0, duplicates: 4 });
      expect(await c.snapshot()).toEqual(before);
    });

    test('a file with main\'s rows plus new ones imports only the new ones, whatever order, and the new rows follow the new behaviour', async () => {
      const before = (await c.snapshot()) as { transactions: { id: string; account_id: string; payee_id: string | null; import_payee_name: string }[]; payees: { name: string }[]; hints: { transaction_id: string; account_id: string }[] };
      const fresh: [string, number][] = [['PADOCA 99', -24000], ['PIX SAV 99', -25000], ['PADDED RAW', -26000], ['UBER  TRIP 99', -27000]];
      const mixed = [fx.texts[4]!, fresh[0]!, fx.texts[0]!, fresh[1]!, fx.texts[2]!, fresh[2]!, fx.texts[15]!, fresh[3]!];
      expect(await c.bulk('Savings Conta', plainRows(mixed))).toEqual({ imported: 4, duplicates: 4 });
      const after = (await c.snapshot()) as typeof before;
      const byId = new Map(before.transactions.map((t) => [t.id, t]));
      expect(after.transactions.filter((t) => byId.has(t.id))).toEqual(before.transactions);
      const find = (text: string) => after.transactions.find((t) => t.import_payee_name === text)!;
      // The rule's payee, the text kept as the import name, no payee made of the spliced text.
      expect(find('PADOCA 99').payee_id).toBe(c.idOf('Padaria'));
      expect(find('PADDED RAW').payee_id).toBe(c.idOf(' Padded ')); // main trimmed it into a second "Padded" payee
      expect(find('UBER  TRIP 99').payee_id).not.toBe(c.idOf('Uber')); // main never matched the double space: still an ordinary payee of the text
      const names = after.payees.map((p) => p.name);
      for (const junk of ['Padaria 99', 'Transfer : Nubank Conta 99', 'Uber 99']) expect(names).not.toContain(junk);
      // The transfer text stays an ordinary row with a hint for Nubank: no mirror, no half transfer.
      const pix = find('PIX SAV 99');
      expect(after.hints.find((h) => h.transaction_id === pix.id)?.account_id).toBe(c.accounts['Nubank Conta']);
      expect(after.transactions.filter((t) => t.account_id === c.accounts['Nubank Conta'])).toHaveLength(0);
      // Idempotent from now on.
      expect(await c.bulk('Savings Conta', plainRows([...fresh, fx.texts[0]!]))).toEqual({ imported: 0, duplicates: 5 });
      expect((await c.snapshot() as typeof before).payees).toEqual(after.payees);
    });

    test('a row the bank changes, or a new bank row, takes the new behaviour; the rows next to it do not move', async () => {
      const before = (await c.snapshot()) as { transactions: { id: string; account_id: string; import_id: string }[]; hints: { transaction_id: string; account_id: string }[]; balances: { id: string; c: string }[]; payees: { id: string; name: string }[]; shadows: { transaction_id: string; last_synced_payload: Record<string, unknown> }[] };
      // c5 "PIX SAV 42" (a transfer payee's rule) and c9 "MERCADO LIVRE SP" (overlapping rules) change amount; two new texts arrive.
      upstream = mainUpstream().map((t) => (t.externalId === 'c5' ? { ...t, amount: -5500 } : t.externalId === 'c9' ? { ...t, amount: -9500 } : t));
      upstream.push(up('new1', 'UBER TRIP 999', -1500), up('new2', 'PIX SAV 7', -2500));
      const result = await c.sync();
      expect(result).toMatchObject({ added: 2, updated: 2, blocked: 1, failed: 0, duplicates: 21 });
      const after = (await c.snapshot()) as typeof before & { payees: { id: string; name: string }[]; shadows: { transaction_id: string; last_synced_payload: Record<string, unknown> }[] };
      const ext = (snap: { transactions: { id: string; import_id: string }[] }, e: string) => snap.transactions.find((t) => t.import_id === `${PROVIDER}:${e}`) as never as Record<string, unknown> & { id: string };
      // Unchanged rows are byte-identical.
      for (const t of before.transactions.filter((x) => x.account_id === c.accounts['Itau Conta'] && !['c5', 'c9'].some((e) => x.import_id === `${PROVIDER}:${e}`))) {
        expect(after.transactions.find((x) => x.id === t.id)).toEqual(t);
      }
      const c9 = ext(after, 'c9');
      expect(c9).toMatchObject({ payee_id: c.idOf('Mercado Livre'), import_payee_name: 'MERCADO LIVRE SP', amount: '-9500' });
      expect(after.shadows.find((s) => s.transaction_id === c9.id)!.last_synced_payload).toMatchObject({ payee: 'Mercado Livre', amount: -9500 });
      const c5 = ext(after, 'c5');
      expect(c5.import_payee_name).toBe('PIX SAV 42');
      expect(c5.payee_id).toBe(after.payees.find((p) => p.name === 'PIX SAV 42')?.id ?? 'missing');
      expect(after.hints.find((h) => h.transaction_id === c5.id)?.account_id).toBe(c.accounts['Nubank Conta']);
      expect(ext(after, 'new1')).toMatchObject({ payee_id: c.idOf('Uber'), import_payee_name: 'UBER TRIP 999' });
      expect(after.payees.map((p) => p.name)).not.toContain('Uber 999');
      expect(after.hints.find((h) => h.transaction_id === ext(after, 'new2').id)?.account_id).toBe(c.accounts['Nubank Conta']);
      const bal = (snap: typeof after) => Number(snap.balances.find((b) => b.id === c.accounts['Itau Conta'])!.c);
      expect(bal(after) - bal(before)).toBe(-500 - 500 - 1500 - 2500);
      // A second pass is quiet.
      expect(await c.sync()).toMatchObject({ added: 0, updated: 0, blocked: 1, failed: 0, duplicates: 25 });
      expect(((await c.snapshot()) as typeof after).transactions).toEqual(after.transactions);
    });
  });
}

describe.skipIf(!dbReady)('migration 0121 never drops a rule and keeps main\'s comparison', () => {
  test('every live payee\'s rule is a row, as written; patterns differing only by case or by spaces stay separate rules', async () => {
    const c = await build('mig', true);
    budgets.push(c.B);
    const rows = (await pool.query<{ payee: string; match_type: string; condition: string }>(
      `SELECT p.name AS payee, r.match_type, r.condition FROM payee_renaming_rules r JOIN payees p ON p.id = r.payee_id WHERE r.budget_id = $1 ORDER BY r.created_at, r.id`,
      [c.B],
    )).rows;
    const expected = fx.payees.filter((p) => p.type && p.condition).map((p) => ({ payee: p.name, match_type: p.type as string, condition: p.condition as string }));
    expect(rows).toEqual(expected);
    for (const name of ['Loja', 'Loja Dead', 'Casa Old', 'Casa New']) expect(rows.map((r) => r.payee)).toContain(name);
    // A second run changes nothing.
    await pool.query(MIGRATION);
    expect((await pool.query('SELECT count(*)::int AS n FROM payee_renaming_rules WHERE budget_id = $1', [c.B])).rows[0].n).toBe(expected.length);
  });
});

describe.skipIf(!dbReady)('rows imported from now on: what the matcher and the person see', () => {
  test('F1: a statement row assigned by a rule is untouched for the matcher wherever main counted its row untouched', async () => {
    const c = await build('f1', true);
    budgets.push(c.B);
    // Same texts into a new account, assigned by the rules of the table.
    const { listTransferCandidates } = await import('../budget/store/transfers');
    const fresh = crypto.randomUUID();
    await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$2,'Fresh Conta','checking','CASH',true)`, [fresh, c.B]);
    c.accounts['Fresh Conta'] = fresh;
    expect(await c.bulk('Fresh Conta', plainRows())).toMatchObject({ imported: 24 });
    expect(await c.bulk('Fresh Conta', clientRows(fx.client.filter((r) => r.payee === r.original)))).toMatchObject({ imported: 3 });
    const candidates = await listTransferCandidates(pool, c.B);
    const untouchedNow = new Map(candidates.filter((x) => x.account_id === fresh).map((x) => [`${x.amount}`, x.untouched_ledger]));
    expect(untouchedNow.size).toBeGreaterThan(20);
    let mainTrue = 0;
    for (const r of [...fx.bulk_rows, ...fx.client_rows.filter((x) => x.import_payee_name === x.import_payee_name_original)]) {
      if (!r.untouched) continue;
      mainTrue += 1;
      expect(untouchedNow.get(`${r.amount}`), `main counted ${r.import_payee_name_original} untouched`).toBe(true);
    }
    expect(mainTrue).toBeGreaterThan(5);
    // A text a rule of an ordinary payee matched whose spliced payee name equalled it: main counted it untouched.
    expect(fx.bulk_rows.find((r) => r.import_payee_name_original === 'Cafe Central 1')).toMatchObject({ payee: 'Cafe Central 1', untouched: true });
    // Rows main called touched stay touched (no more auto-links than main on a rule-assigned statement row), the one exception
    // being rows where the overlapping rules now pick another winner than main's first-created.
    const overlap = new Set([-9000, -18000, -18100, -21100]);
    for (const r of [...fx.bulk_rows, ...fx.client_rows.filter((x) => x.import_payee_name === x.import_payee_name_original)]) {
      if (overlap.has(r.amount)) continue;
      // A text a rule of a transfer payee matches keeps the ordinary payee of its text and a hint (T3): as imported, so untouched.
      const hinted = r.hint !== null || r.payee?.startsWith('Transfer : ');
      expect(untouchedNow.get(`${r.amount}`), `main said ${r.untouched} for ${r.import_payee_name_original}`).toBe(hinted ? true : r.untouched);
    }
    // A row the person gave another payee is touched.
    await pool.query('UPDATE transactions SET payee_id = $2 WHERE account_id = $1 AND amount = -10000', [fresh, c.idOf('Corner Shop')]);
    expect((await listTransferCandidates(pool, c.B)).find((x) => x.account_id === fresh && `${x.amount}` === '-10000')?.untouched_ledger).toBe(false);
  });

  test('F2: a payee the person chose in the import screen is not re-assigned by a rule; the statement text still is', async () => {
    const c = await build('f2', true);
    budgets.push(c.B);
    const fresh = crypto.randomUUID();
    await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$2,'Fresh Conta','checking','CASH',true)`, [fresh, c.B]);
    c.accounts['Fresh Conta'] = fresh;
    // "Uber Trip Plus" contains the pattern of Uber's rule; the person picked it in the screen.
    const chosen = { date, payee: 'Uber Trip Plus', memo: '', outflow: 21_300, inflow: 0, category_id: null, import_payee_name: 'Uber Trip Plus', import_payee_name_original: 'UBER TRIP PLUS 5' };
    const text = { date, payee: 'UBER TRIP PLUS 6', memo: '', outflow: 21_400, inflow: 0, category_id: null, import_payee_name: 'UBER TRIP PLUS 6', import_payee_name_original: 'UBER TRIP PLUS 6' };
    expect(await c.bulk('Fresh Conta', [chosen, text])).toEqual({ imported: 2, duplicates: 0 });
    const rows = (await pool.query<{ amount: string; payee: string }>('SELECT t.amount::text, p.name AS payee FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE t.account_id = $1', [fresh])).rows;
    expect(rows.find((r) => r.amount === '-21300')!.payee).toBe('Uber Trip Plus');
    expect(rows.find((r) => r.amount === '-21400')!.payee).toBe('Uber');
    expect(await c.bulk('Fresh Conta', [chosen, text])).toEqual({ imported: 0, duplicates: 2 });
  });
});

describe.skipIf(!dbReady)('the payee columns stay an input after the migration', () => {
  test('B3: a rule written only to the columns (the other app) applies on the next sync and survives a later rule add on the same payee', async () => {
    const c = await build('b3', true);
    budgets.push(c.B);
    const shop = c.idOf('Corner Shop');
    await pool.query("UPDATE payees SET rename_match_type = 'contains', rename_condition = 'CORNER BAKERY' WHERE id = $1", [shop]);
    upstream = [...mainUpstream(), up('b3-new', 'CORNER BAKERY 12', -3300)];
    expect(await c.sync()).toMatchObject({ added: 1, updated: 0, blocked: 1, duplicates: 23 });
    const row = (await pool.query('SELECT payee_id, import_payee_name FROM transactions WHERE import_id = $1', [`${PROVIDER}:b3-new`])).rows[0];
    expect(row).toEqual({ payee_id: shop, import_payee_name: 'CORNER BAKERY 12' });
    // A rule added later through the API on the same payee: the column rule is adopted, not erased by the mirror.
    const added = await op('budget_payees_rename_rules_add', { id: shop, budget_id: c.B, match_type: 'starts_with', condition: 'CORNER' });
    expect(added.status).toBe(201);
    const rules = (await op('budget_payees_rename_rules_list', { id: shop, budget_id: c.B })).json as { match_type: string; condition: string }[];
    expect(rules.map((r) => [r.match_type, r.condition])).toEqual([['contains', 'CORNER BAKERY'], ['starts_with', 'CORNER']]);
    expect((await pool.query('SELECT rename_match_type AS t, rename_condition AS c FROM payees WHERE id = $1', [shop])).rows[0]).toEqual({ t: 'contains', c: 'CORNER BAKERY' });
    upstream = [...upstream, up('b3-two', 'CORNER BAKERY 13', -3400)];
    expect(await c.sync()).toMatchObject({ added: 1, updated: 0, failed: 0 });
    expect((await pool.query('SELECT payee_id FROM transactions WHERE import_id = $1', [`${PROVIDER}:b3-two`])).rows[0].payee_id).toBe(shop);
  });
});
