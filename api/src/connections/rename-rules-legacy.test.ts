/**
 * Rows imported under the earlier renaming behaviour (budget-mkrt, transfers T3b).
 *
 * Until a matching rule ASSIGNED its payee, a `contains` rule rewrote only the
 * matching part of the text ("PIX SAV 42" -> "Transfer : Nubank Conta 42", "PADOCA 42"
 * -> "Padaria 42") and that rewritten text was stored as an ordinary payee. Those rows
 * are in the database. This file proves they stay as they are:
 *  - a bank sync and a statement re-import of the same data (as main stored it) change,
 *    duplicate and skip nothing and create no payee; import keys and dedupe stay;
 *  - the new behaviour applies to rows INSERTED from now on and to rows the bank
 *    actually changes, and only to those.
 *
 * The expected state is NOT computed by this branch's code: testdata/main-rename-capture.json
 * was recorded by running main (6027e7c) on the same texts (script: testdata/capture-main-rename.ts.txt),
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
  main_results: Record<string, Record<string, number>>;
  payees: { name: string; transfer: string | null; type: string | null; condition: string | null }[];
  sync_rows: {
    external_id: string;
    amount: number;
    payee: string | null;
    import_payee_name: string | null;
    import_payee_name_original: string | null;
    shadow_payee: string;
    hint_account: string | null;
  }[];
  bulk_rows: { amount: number; payee: string | null; import_payee_name: string; hint: string | null; key_payee: string; occ: number }[];
}
const fx = JSON.parse(readFileSync(join(import.meta.dir, 'testdata', 'main-rename-capture.json'), 'utf8')) as Capture;

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

const B = crypto.randomUUID();
const ACCOUNTS: Record<string, string> = {
  'Itau Conta': crypto.randomUUID(),
  'Nubank Conta': crypto.randomUUID(),
  'Third Conta': crypto.randomUUID(),
  'Savings Conta': crypto.randomUUID(),
};
const itau = ACCOUNTS['Itau Conta']!;
const savings = ACCOUNTS['Savings Conta']!;
const EXT_ITAU = 'up-acc-legacy-itau';
const date = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let upstream: AggregatedTransaction[] = [];
const aggregator = {
  environment: 'production',
  listTransactions: async () => ({ transactions: upstream.map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
let connId = '';
const sync = () => syncConnectionTransactions({ userId: user.id, connectionId: connId, aggregator, ignoreWatermark: true });
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
const bulkRows = (texts = fx.texts) => texts.map(([payee, amount]) => ({ date, payee, memo: '', outflow: -amount, inflow: 0, category_id: null }));
const bulk = async (rows: ReturnType<typeof bulkRows>) =>
  (await op('budget_transactions_bulk_import', { budget_id: B, account_id: savings, txns: rows })).json as { imported: number; duplicates: number };

const payeeIds = new Map<string, string>();
const idOf = (name: string) => payeeIds.get(name) ?? (() => { throw new Error(`no payee ${name}`); })();

/** Everything a re-sync or re-import could touch, in a comparable form. */
async function snapshot() {
  return {
    transactions: (
      await pool.query(
        `SELECT t.id, t.account_id, t.date::text AS date, t.amount::text AS amount, t.payee_id, t.import_id, t.import_payee_name,
                t.import_payee_name_original, t.cleared, t.approved, t.deleted, t.category_id, t.memo
           FROM transactions t WHERE t.budget_id = $1 ORDER BY t.import_id, t.id`,
        [B],
      )
    ).rows,
    payees: (await pool.query('SELECT id, name, deleted, transfer_account_id FROM payees WHERE budget_id = $1 ORDER BY id', [B])).rows,
    shadows: (
      await pool.query('SELECT transaction_id, last_synced_payload, blocked, updated_at::text AS updated_at FROM connection_transactions WHERE budget_id = $1 ORDER BY transaction_id', [B])
    ).rows,
    hints: (await pool.query('SELECT transaction_id, account_id FROM transfer_hints WHERE budget_id = $1 ORDER BY transaction_id', [B])).rows,
    balances: (await pool.query('SELECT id, cleared_balance::text AS c, uncleared_balance::text AS u FROM accounts WHERE budget_id = $1 ORDER BY id', [B])).rows,
  };
}

describe.skipIf(!dbReady)('rows imported under the earlier renaming behaviour stay as they are', () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [B, 'rules-legacy', user.id]);
    await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [B, user.id]);
    for (const [name, id] of Object.entries(ACCOUNTS)) {
      await pool.query(`INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES ($1,$2,$3,'checking','CASH',true)`, [id, B, name]);
    }
    const c = await store.upsertConnection({ userId: user.id, provider: PROVIDER, externalId: `up-item-legacy-${user.id}`, clientUserId: `cu-${user.id}`, status: 'connected', environment: 'production' });
    connId = c.id;
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [connId, EXT_ITAU, itau, 'itau']);

    // The payees main had, in creation order, each with its one rule; the rules move to the rules table.
    for (const p of fx.payees) {
      const accountId = p.transfer ? ACCOUNTS[p.transfer]! : null;
      const r = await pool.query<{ id: string }>('INSERT INTO payees (budget_id, name, transfer_account_id) VALUES ($1,$2,$3) RETURNING id', [B, p.name, accountId]);
      payeeIds.set(p.name, r.rows[0]!.id);
      if (accountId) await pool.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [r.rows[0]!.id, accountId]);
      if (p.type && p.condition) {
        await pool.query('INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition) VALUES ($1,$2,$3,$4)', [B, r.rows[0]!.id, p.type, p.condition]);
      }
    }

    // The rows main stored, written literally.
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
         VALUES ($1,$2,$3,$4,$5,false,$6,now())`,
        [id, B, PROVIDER, r.external_id, JSON.stringify({ date, amount: r.amount, memo: '', payee: r.shadow_payee }), JSON.stringify({ id: r.external_id })],
      );
      if (r.hint_account) await pool.query('INSERT INTO transfer_hints (transaction_id, budget_id, account_id) VALUES ($1,$2,$3)', [id, B, ACCOUNTS[r.hint_account]]);
    }
    for (const r of fx.bulk_rows) {
      const id = await insert(savings, {
        amount: r.amount,
        payee: r.payee,
        importId: `YNAB:${r.amount}:${date}:${idOf(r.key_payee)}:${r.occ}`,
        importName: r.import_payee_name,
        importOriginal: r.import_payee_name,
      });
      if (r.hint) await pool.query('INSERT INTO transfer_hints (transaction_id, budget_id, account_id) VALUES ($1,$2,$3)', [id, B, ACCOUNTS[r.hint]]);
    }
    for (const [accountId, col] of [[itau, 'cleared_balance'], [savings, 'uncleared_balance']] as const) {
      await pool.query(`UPDATE accounts SET ${col} = (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE account_id = $1) WHERE id = $1`, [accountId]);
    }
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [B]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    await pool.query('DELETE FROM connections WHERE provider = $1', [PROVIDER]);
  });

  test('the capture is what main did: every row dupes on its second pass', () => {
    expect(fx.main_results.sync2).toMatchObject({ added: 0, updated: 0, duplicates: 12 });
    expect(fx.main_results.bulk2).toEqual({ imported: 0, duplicates: 12 });
    // And the old behaviour really did splice: this is the kind of row that must stay.
    expect(fx.sync_rows.find((r) => r.import_payee_name === 'PADOCA 42' || r.payee === 'Padaria 42')).toBeTruthy();
    expect(fx.sync_rows.map((r) => r.payee)).toContain('Transfer : Nubank Conta 42');
  });

  test('a bank sync of data main stored changes, creates and skips nothing, twice', async () => {
    upstream = mainUpstream();
    const before = await snapshot();
    const first = await sync();
    const second = await sync();
    expect(first).toMatchObject({ added: 0, updated: 0, deleted: 0, blocked: 0, failed: 0, duplicates: 12 });
    expect(second).toMatchObject({ added: 0, updated: 0, deleted: 0, blocked: 0, failed: 0, duplicates: 12 });
    const after = await snapshot();
    // Only the raw payload refresh (outside this snapshot) differs: payees, rows, shadows, hints, balances are identical.
    expect(after).toEqual(before);
    // The partially replaced payees are still the stored ones.
    const names = after.payees.map((p) => p.name);
    for (const n of ['Padaria 42', 'Uber *trip 123', 'Transfer : Nubank Conta 42', 'Mercadoado livre sp']) expect(names).toContain(n);
  });

  test('a statement re-import of data main stored duplicates and creates nothing: same keys, same dedupe', async () => {
    const before = await snapshot();
    expect(await bulk(bulkRows())).toEqual({ imported: 0, duplicates: 12 });
    expect(await bulk(bulkRows())).toEqual({ imported: 0, duplicates: 12 });
    expect(await snapshot()).toEqual(before);
  });

  test('a statement file with main\'s rows plus new ones imports only the new ones, whatever order', async () => {
    const before = await snapshot();
    const fresh: [string, number][] = [['PADOCA 99', -14000], ['PIX SAV 99', -15000], ['PADDED RAW', -16000]];
    const result = await bulk(bulkRows([fx.texts[3]!, fresh[0]!, fx.texts[0]!, fresh[1]!, fx.texts[4]!, fresh[2]!]));
    expect(result).toEqual({ imported: 3, duplicates: 3 });
    const after = await snapshot();
    // Main's rows are untouched.
    const mainIds = new Set(before.transactions.map((t) => t.id));
    expect(after.transactions.filter((t) => mainIds.has(t.id))).toEqual(before.transactions);
    // The new rows follow the new behaviour: the rule's payee, the text kept as the import name, no junk payee.
    const padoca = after.transactions.find((t) => t.import_payee_name === 'PADOCA 99')!;
    expect(padoca.payee_id).toBe(idOf('Padaria'));
    const pix = after.transactions.find((t) => t.import_payee_name === 'PIX SAV 99')!;
    expect(pix.payee_id).not.toBeNull();
    const names = after.payees.map((p) => p.name);
    expect(names).not.toContain('Padaria 99');
    expect(names).not.toContain('Transfer : Nubank Conta 99');
    // The transfer text stays an ordinary row with a hint for Nubank: no mirror, no half transfer.
    expect(after.hints.find((h) => h.transaction_id === pix.id)?.account_id).toBe(ACCOUNTS['Nubank Conta']);
    expect(after.transactions.filter((t) => t.account_id === ACCOUNTS['Nubank Conta'])).toHaveLength(0);
    // A rule whose payee has surrounding spaces in its name is assigned as it is (main trimmed it and made a "Padded" payee).
    expect(after.transactions.find((t) => t.import_payee_name === 'PADDED RAW' && t.amount === '-16000')!.payee_id).toBe(idOf(' Padded '));
    // And they are idempotent from now on.
    expect(await bulk(bulkRows([fresh[0]!, fresh[1]!, fresh[2]!, fx.texts[0]!]))).toEqual({ imported: 0, duplicates: 4 });
    expect((await snapshot()).payees).toEqual(after.payees);
  });

  test('a bank row that is new, or that the bank changes, takes the new behaviour; the rows next to it do not move', async () => {
    const before = await snapshot();
    const itauRowIds = new Set(before.transactions.filter((t) => t.account_id === itau).map((t) => t.id));
    // c0 "PADOCA 42" changes amount; c4 "PIX SAV 42" (a transfer payee rule) changes amount; a brand new text arrives.
    upstream = mainUpstream().map((t) =>
      t.externalId === 'c0' ? { ...t, amount: -10500 } : t.externalId === 'c4' ? { ...t, amount: -5500 } : t,
    );
    upstream.push(up('new1', 'UBER *TRIP 999', -1500), up('new2', 'PIX SAV 7', -2500));
    const result = await sync();
    expect(result).toMatchObject({ added: 2, updated: 2, blocked: 0, failed: 0, duplicates: 10 });
    const after = await snapshot();
    const byExternal = (snap: typeof after, ext: string) => snap.transactions.find((t) => t.import_id === `${PROVIDER}:${ext}`)!;

    // Unchanged rows are byte-identical.
    for (const t of before.transactions.filter((x) => x.account_id === itau && !['c0', 'c4'].some((e) => x.import_id === `${PROVIDER}:${e}`))) {
      expect(after.transactions.find((x) => x.id === t.id)).toEqual(t);
    }
    // Changed rows: the rule's payee, the bank text as the import name, the shadow agrees, the balance moved by the difference.
    const c0 = byExternal(after, 'c0');
    expect(c0).toMatchObject({ payee_id: idOf('Padaria'), import_payee_name: 'PADOCA 42', import_payee_name_original: 'PADOCA 42', amount: '-10500' });
    expect(after.shadows.find((s) => s.transaction_id === c0.id)!.last_synced_payload).toMatchObject({ payee: 'Padaria', amount: -10500 });
    const c4 = byExternal(after, 'c4');
    expect(c4.import_payee_name).toBe('PIX SAV 42');
    // The ordinary payee of the text, as a hinted row has (created now: this row is being changed).
    expect(c4.payee_id).toBe(after.payees.find((p) => p.name === 'PIX SAV 42')?.id ?? 'missing');
    expect(after.hints.find((h) => h.transaction_id === c4.id)?.account_id).toBe(ACCOUNTS['Nubank Conta']);
    // New rows: the rule's payee, no payee made of the spliced text.
    const new1 = byExternal(after, 'new1');
    expect(new1).toMatchObject({ payee_id: idOf('Uber'), import_payee_name: 'UBER *TRIP 999' });
    expect(after.payees.map((p) => p.name)).not.toContain('Uber *trip 999');
    expect(after.payees.map((p) => p.name)).not.toContain('Transfer : Nubank Conta 7');
    expect(after.hints.find((h) => h.transaction_id === byExternal(after, 'new2').id)?.account_id).toBe(ACCOUNTS['Nubank Conta']);
    // Money: only the two changes and the two new rows moved the account (cleared bank rows).
    const bal = (snap: typeof after) => Number(snap.balances.find((b) => b.id === itau)!.c);
    expect(bal(after) - bal(before)).toBe(-500 - 500 - 1500 - 2500);
    // Nothing else changed in this sync: the main-era rows of the other account are exactly as they were.
    expect(after.transactions.filter((t) => t.account_id === savings && itauRowIds.has(t.id))).toEqual([]);
    // A second pass is quiet: the rewritten rows are their own duplicates.
    expect(await sync()).toMatchObject({ added: 0, updated: 0, blocked: 0, failed: 0, duplicates: 14 });
    expect((await snapshot()).transactions).toEqual(after.transactions);
  });
});
