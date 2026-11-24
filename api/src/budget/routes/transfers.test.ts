/**
 * Transfers between own accounts through the operations (budget-mit6):
 * suggestions on the register list and the review list, linking a pair (with
 * the payee rule), Undo, "not a transfer", linking to an account with no row
 * (mirror), the payee rule read/save with "apply to past rows", the /bulk
 * import path, budget isolation and idempotent backfill. DB-gated.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { contracts } from '../../catalog';
import { pool, withTransaction } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { makeOpCaller } from '../../core/test-op';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import budget from '..';
import { linkTransfers } from '../domain/transfer-links';

const user: IdentityUser = {
  id: crypto.randomUUID(),
  email: 'mit6-routes@syscd.local',
  googleSub: null,
  role: 'user',
  status: 'active',
};
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const B = crypto.randomUUID();
const OTHER = crypto.randomUUID();
const itau = crypto.randomUUID();
const nubank = crypto.randomUUID();
const nucard = crypto.randomUUID();
const otherAcc = crypto.randomUUID();
const groupId = crypto.randomUUID();
const categoryId = crypto.randomUUID();
let seq = 0;

/** A bank-imported row (untouched unless `edited`), optionally with a Pluggy raw payload. */
async function imported(
  account: string,
  amount: number,
  date: string,
  payee: string,
  opts: { raw?: Record<string, unknown>; edited?: boolean; budget?: string } = {},
): Promise<string> {
  const budgetId = opts.budget ?? B;
  const p = await pool.query<{ id: string }>(
    `INSERT INTO payees (budget_id, name) VALUES ($1, $2)
     ON CONFLICT (budget_id, name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
    [budgetId, opts.edited ? `${payee} (edited)` : payee],
  );
  const t = await pool.query<{ id: string }>(
    `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted,
       import_id, import_payee_name, import_payee_name_original)
     VALUES ($1,$2,$3,$4,$5,'cleared',false,'never',false,$6,$7,$7) RETURNING id`,
    [budgetId, account, date, amount, p.rows[0].id, `mit6:${++seq}`, payee],
  );
  const id = t.rows[0].id;
  if (opts.raw) {
    await pool.query(
      `INSERT INTO connection_transactions (transaction_id, budget_id, provider, external_transaction_id, last_synced_payload, blocked, raw_payload)
       VALUES ($1,$2,'mit6',$3,'{}',false,$4)`,
      [id, budgetId, `x-${seq}`, JSON.stringify(opts.raw)],
    );
  }
  return id;
}

const reset = async () => {
  await pool.query('DELETE FROM transactions WHERE budget_id = ANY($1)', [[B, OTHER]]);
  await pool.query('UPDATE payees SET transfer_rule = NULL, transfer_rule_since = NULL WHERE budget_id = $1', [B]);
  await pool.query('UPDATE accounts SET cleared_balance = 0, uncleared_balance = 0 WHERE budget_id = $1', [B]);
};
const list = async () => {
  const res = await op('budget_transactions_list', { budget_id: B });
  expect(res.status).toBe(200);
  return new Map<string, Record<string, unknown>>(res.json.map((r: { id: string }) => [r.id, r]));
};
const get = async (id: string) =>
  (
    await pool.query(
      `SELECT t.transfer_account_id, t.transfer_transaction_id, t.category_id, t.payee_id, t.deleted, p.name AS payee
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id WHERE t.id = $1`,
      [id],
    )
  ).rows[0];
const runLinker = () => withTransaction(pool, (c) => linkTransfers(c, B));
const today = new Date().toISOString().slice(0, 10);
const SAME_PERSON = { category: 'Same person transfer', operationType: 'PIX' };

describe.skipIf(!dbReady)('transfers between own accounts (operations)', () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3),($4,$5,$3)', [B, 'mit6', user.id, OTHER, 'mit6-other']);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group) VALUES
       ($1,$5,'Itau Conta','checking','CASH'),($2,$5,'Nubank Conta','checking','CASH'),
       ($3,$5,'Nubank Cartao','creditCard','CREDIT'),($4,$6,'Other Budget Conta','checking','CASH')`,
      [itau, nubank, nucard, otherAcc, B, OTHER],
    );
    await pool.query('INSERT INTO category_groups (id, budget_id, name) VALUES ($1,$2,$3)', [groupId, B, 'G']);
    await pool.query('INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1,$2,$3,$4)', [categoryId, B, groupId, 'Gifts']);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [[B, OTHER]]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  test('backfill links a unique cash-to-cash pair once (idempotent), and never across budgets', async () => {
    await reset();
    const a = await imported(itau, -3_000_000, '2026-11-03', 'Pix enviado Yuri freire lima');
    const b = await imported(nubank, 3_000_000, '2026-11-03', 'Transferência Recebida|YURI FREIRE LIMA');
    await imported(otherAcc, 3_000_000, '2026-11-03', 'Transferência Recebida', { budget: OTHER });
    // Two candidates for `a` in B? No: the other budget's row never counts.
    expect(await runLinker()).toBe(1);
    expect(await get(a)).toMatchObject({ transfer_transaction_id: b, payee: 'Transfer : Nubank Conta' });
    const before = await pool.query('SELECT * FROM transactions WHERE budget_id = $1 ORDER BY id', [B]);
    expect(await runLinker()).toBe(0);
    const after = await pool.query('SELECT * FROM transactions WHERE budget_id = $1 ORDER BY id', [B]);
    expect(after.rows).toEqual(before.rows);
    const rows = await list();
    expect(rows.get(a)!.transfer_link_method).toBe('auto');
  });

  test('an edited row is only suggested: register summary on both rows, review list with why', async () => {
    await reset();
    const a = await imported(itau, -350_000, '2026-10-24', 'Pix enviado', { edited: true, raw: SAME_PERSON });
    const b = await imported(nubank, 350_000, '2026-10-24', 'Transferência Recebida', { raw: SAME_PERSON });
    expect(await runLinker()).toBe(0);
    const rows = await list();
    expect(rows.get(a)!.transfer_suggestion).toEqual({ confidence: 'sure', candidate_count: 1, counterpart_id: b });
    expect(rows.get(b)!.transfer_suggestion).toEqual({ confidence: 'sure', candidate_count: 1, counterpart_id: a });
    const res = await op('budget_transfer_suggestions_list', { budget_id: B, account_id: nubank });
    expect(res.status).toBe(200);
    expect(res.json).toHaveLength(1);
    expect(res.json[0]).toMatchObject({
      id: a,
      confidence: 'sure',
      basis: 'unique',
      leg: { transaction_id: a, account_name: 'Itau Conta', bank_label: 'Same person transfer', untouched: false },
      candidates: [{ transaction_id: b, account_name: 'Nubank Conta', days_apart: 0, amount: 350_000 }],
    });
  });

  test('link a pair with "always treat as transfer", then Undo restores both rows', async () => {
    await reset();
    const a = await imported(itau, -120_000, '2026-10-21', 'Pix enviado Ana', { edited: true });
    const b = await imported(nubank, 120_000, '2026-10-21', 'Recebido Ana');
    await pool.query('UPDATE transactions SET category_id = $2 WHERE id = $1', [a, categoryId]);
    const before = await get(a);
    const res = await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a, counterpart_id: b }], remember_payee: true });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    expect(res.json.linked.sort()).toEqual([a, b].sort());
    expect(res.json.rules_created).toBe(1);
    expect(await get(a)).toMatchObject({ transfer_transaction_id: b, category_id: null, payee: 'Transfer : Nubank Conta' });
    const rule = await op('budget_payees_transfer_rule_get', { id: before.payee_id, budget_id: B });
    expect(rule.json).toMatchObject({ mode: 'auto', no_match: 'outside', wait_days: 5 });
    expect((await list()).get(b)!.transfer_link_method).toBe('user');
    // Linking the same row again is a conflict.
    expect((await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a, counterpart_id: b }] })).status).toBe(409);

    const undo = await op('budget_transfers_unlink', { budget_id: B, transaction_ids: res.json.linked });
    expect(undo.json).toEqual({ unlinked: 1 });
    expect(await get(a)).toMatchObject({ transfer_transaction_id: null, category_id: categoryId, payee_id: before.payee_id });
    // Undone links are never auto-linked again (even though the rule exists, they stay suggestions).
    await pool.query('UPDATE transactions SET category_id = NULL WHERE id = $1', [a]);
    expect(await runLinker()).toBe(0);
    expect((await list()).get(a)!.transfer_suggestion).toMatchObject({ confidence: 'sure', counterpart_id: b });
  });

  test('"not a transfer" hides a row for good; clearing the decision brings it back', async () => {
    await reset();
    const a = await imported(itau, -55_000, '2026-10-10', 'Pix', { edited: true });
    await imported(nubank, 55_000, '2026-10-10', 'Recebido');
    const res = await op('budget_transfers_mark', { budget_id: B, transaction_ids: [a], state: 'dismissed' });
    expect(res.json).toEqual({ updated: 1 });
    expect((await list()).get(a)!.transfer_suggestion).toBeNull();
    expect((await op('budget_transfer_suggestions_list', { budget_id: B })).json).toEqual([]);
    expect(await runLinker()).toBe(0);
    await op('budget_transfers_mark', { budget_id: B, transaction_ids: [a], state: null });
    expect((await list()).get(a)!.transfer_suggestion).not.toBeNull();
    // Marking a row outside the budget: pending "outside", no suggestion.
    await op('budget_transfers_mark', { budget_id: B, transaction_ids: [a], state: 'outside' });
    expect((await list()).get(a)).toMatchObject({ transfer_pending: 'outside', transfer_suggestion: null });
  });

  test('link to an account with no matching row creates the other leg; Undo deletes it and its balance', async () => {
    await reset();
    const a = await imported(itau, -800_000, '2026-10-18', 'TED Yuri F Lima', { raw: SAME_PERSON });
    expect((await list()).get(a)!.transfer_suggestion).toEqual({ confidence: 'one_side', candidate_count: 0, counterpart_id: null });
    const res = await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a, account_id: nucard }] });
    expect(res.status, JSON.stringify(res.json)).toBe(200);
    const mirrorId = res.json.linked.find((id: string) => id !== a);
    const bal = async () =>
      (await pool.query('SELECT cleared_balance::int + uncleared_balance::int AS b FROM accounts WHERE id = $1', [nucard])).rows[0].b;
    expect(await bal()).toBe(800_000);
    expect(await get(mirrorId)).toMatchObject({ transfer_transaction_id: a, deleted: false });
    await op('budget_transfers_unlink', { budget_id: B, transaction_ids: [a] });
    expect(await get(mirrorId)).toMatchObject({ deleted: true });
    expect(await bal()).toBe(0);
    expect(await get(a)).toMatchObject({ transfer_transaction_id: null, payee: 'TED Yuri F Lima' });
  });

  test('link validation: amounts must mirror, ids must be in the budget', async () => {
    await reset();
    const a = await imported(itau, -10_000, '2026-10-01', 'X');
    const b = await imported(nubank, 20_000, '2026-10-01', 'Y');
    const c = await imported(otherAcc, 10_000, '2026-10-01', 'Z', { budget: OTHER });
    expect((await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a, counterpart_id: b }] })).status).toBe(400);
    expect((await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a, counterpart_id: c }] })).status).toBe(404);
    expect((await op('budget_transfers_link', { budget_id: B, links: [{ transaction_id: a }] })).status).toBe(400);
  });

  test('payee rule: new rows wait for their other side; "apply to past rows" links earlier ones', async () => {
    await reset();
    const old = await imported(itau, -40_000, '2026-09-01', 'Pix enviado Bia', { edited: false });
    const oldIn = await imported(nucard, 40_000, '2026-09-02', 'Pagamento recebido', { edited: true });
    const payee = (await get(old)).payee_id as string;
    const saved = await op('budget_payees_set_transfer_rule', { id: payee, budget_id: B, mode: 'auto', wait_days: 5 });
    expect(saved.status, JSON.stringify(saved.json)).toBe(200);
    // The rule is newer than the old row: it is not covered, so the edited pair stays a suggestion.
    expect(saved.json).toMatchObject({ mode: 'auto', linked: 0, past_rows: 1 });
    expect((await get(old)).transfer_transaction_id).toBeNull();

    // A row imported after the rule waits: no category asked.
    const fresh = await imported(itau, -40_000, today, 'Pix enviado Bia');
    expect((await list()).get(fresh)!.transfer_pending).toBe('waiting');
    // Its other side arrives (bulk import path runs the linker).
    const bulk = await op('budget_transactions_bulk_import', {
      budget_id: B,
      account_id: nubank,
      txns: [{ date: today, payee: 'Recebido', memo: '', outflow: 0, inflow: 40_000, category_id: null }],
    });
    expect(bulk.status).toBe(201);
    expect((await get(fresh)).transfer_account_id).toBe(nubank);
    expect((await list()).get(fresh)!.transfer_link_method).toBe('rule');

    const past = await op('budget_payees_set_transfer_rule', { id: payee, budget_id: B, mode: 'auto', apply_to_past: true });
    expect(past.json).toMatchObject({ linked: 1, since: null, past_rows: 0 });
    expect((await get(old)).transfer_transaction_id).toBe(oldIn);

    // Payees list carries the rule; "account" needs an account; "off" clears it.
    const payees = await op('budget_payees_list', { budget_id: B });
    expect(payees.json.find((p: { id: string }) => p.id === payee)).toMatchObject({ transfer_rule: 'auto', transfer_rule_account_id: null });
    expect((await op('budget_payees_set_transfer_rule', { id: payee, budget_id: B, mode: 'account' })).status).toBe(400);
    expect((await op('budget_payees_set_transfer_rule', { id: payee, budget_id: B, mode: 'off' })).json.mode).toBe('off');
  });

  test('a "never" rule suppresses suggestions for the payee', async () => {
    await reset();
    const a = await imported(itau, -66_000, '2026-10-05', 'MAY CONFEITARIA', { edited: true });
    await imported(nubank, 66_000, '2026-10-05', 'Recebido');
    expect((await list()).get(a)!.transfer_suggestion).not.toBeNull();
    const payee = (await get(a)).payee_id as string;
    await op('budget_payees_set_transfer_rule', { id: payee, budget_id: B, mode: 'never' });
    expect((await list()).get(a)!.transfer_suggestion).toBeNull();
  });
});
