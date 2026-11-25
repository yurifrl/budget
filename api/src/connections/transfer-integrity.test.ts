/**
 * Transfer integrity on the server (budget-nq2f, transfers T3), through the
 * operations and the bank sync:
 *  - R1: taking one leg of a matcher-linked transfer out of the pair (payee
 *    edited to an ordinary payee, moved to another peer, or deleted) RESTORES
 *    the other bank-imported row, never deletes it; later syncs neither skip
 *    nor duplicate its bank id; a hand-made mirror is still removed;
 *  - R2: when the bank imports the real other side of a hand-made transfer, the
 *    hand-made mirror is replaced by it (one row, the bank's import id,
 *    balances right, idempotent);
 *  - imports (statement and bank sync) whose payee text means an account's
 *    transfer payee stay ordinary rows with a hint for the matcher;
 *  - the category of a leg of an on-budget pair is dropped on every write path.
 * DB-gated. Lives next to the sync tests: it drives the real bank sync.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
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

const PROVIDER = 'testprovider';
const user: IdentityUser = { id: crypto.randomUUID(), email: 'nq2f-integrity@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const B = crypto.randomUUID();
const itau = crypto.randomUUID();
const nubank = crypto.randomUUID();
const third = crypto.randomUUID();
const house = crypto.randomUUID(); // off budget
const groupId = crypto.randomUUID();
const categoryId = crypto.randomUUID();
const EXT_ITEM = `up-item-nq2f-${user.id}`;
const EXT_ITAU = 'up-acc-nq2f-itau';
const EXT_NU = 'up-acc-nq2f-nubank';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

let upstream: Record<string, AggregatedTransaction[]> = {};
const txn = (acc: string, id: string, milli: number, description: string, raw: Record<string, unknown> = {}, date = daysAgo(1)): AggregatedTransaction => ({
  externalId: id,
  externalAccountId: acc,
  description,
  amount: milli,
  cleared: true,
  date,
  currencyCode: null,
  raw: { id, date: `${date}T12:00:00.000Z`, ...raw },
});
const SAME_PERSON = { category: 'Same person transfer', operationType: 'PIX' };
const aggregator = {
  environment: 'production',
  listTransactions: async (acc: string) => ({ transactions: (upstream[acc] ?? []).map((t) => ({ ...t })), hasMore: false }),
  fetchInstitution: async () => null,
} as unknown as BankAggregator;
let connId = '';
const sync = () => syncConnectionTransactions({ userId: user.id, connectionId: connId, aggregator, ignoreWatermark: true });

interface Row {
  id: string;
  account_id: string;
  amount: number;
  deleted: boolean;
  import_id: string | null;
  payee: string | null;
  category_id: string | null;
  transfer_account_id: string | null;
  transfer_transaction_id: string | null;
  mark: string | null;
  blocked: boolean | null;
}
const rowsOf = async (...accounts: string[]): Promise<Row[]> =>
  (
    await pool.query<Row>(
      `SELECT t.id, t.account_id, t.amount::int AS amount, t.deleted, t.import_id, p.name AS payee, t.category_id,
              t.transfer_account_id, t.transfer_transaction_id, m.state AS mark, s.blocked
       FROM transactions t LEFT JOIN payees p ON p.id = t.payee_id
       LEFT JOIN transfer_marks m ON m.transaction_id = t.id LEFT JOIN connection_transactions s ON s.transaction_id = t.id
       WHERE t.budget_id = $1 AND t.account_id = ANY($2) ORDER BY t.account_id, t.import_id NULLS LAST, t.created_at, t.id`,
      [B, accounts.length ? accounts : [itau, nubank, third, house]],
    )
  ).rows;
const byImport = async (importId: string): Promise<Row> => (await rowsOf()).find((r) => r.import_id === importId)!;
const row = async (id: string): Promise<Row> => (await rowsOf()).find((r) => r.id === id)!;
const balances = async (id: string) => {
  const r = (await pool.query('SELECT cleared_balance AS c, uncleared_balance AS u FROM accounts WHERE id = $1', [id])).rows[0];
  return [Number(r.c), Number(r.u)];
};
/** Cached balances equal a fresh sum over the live ledger. */
async function expectLedgerConsistent() {
  for (const id of [itau, nubank, third, house]) {
    const fresh = (
      await pool.query(
        `SELECT COALESCE(SUM(amount) FILTER (WHERE cleared <> 'uncleared'), 0) AS c,
                COALESCE(SUM(amount) FILTER (WHERE cleared = 'uncleared'), 0) AS u
         FROM transactions WHERE account_id = $1 AND NOT deleted AND NOT upcoming`,
        [id],
      )
    ).rows[0];
    expect(await balances(id)).toEqual([Number(fresh.c), Number(fresh.u)]);
  }
}
const reset = async () => {
  await pool.query('DELETE FROM transactions WHERE budget_id = $1', [B]);
  await pool.query('DELETE FROM connection_transactions WHERE budget_id = $1', [B]);
  await pool.query('UPDATE accounts SET cleared_balance = 0, uncleared_balance = 0 WHERE budget_id = $1', [B]);
  await pool.query('UPDATE payees SET rename_match_type = NULL, rename_condition = NULL WHERE budget_id = $1', [B]);
  upstream = {};
};
const patch = (id: string, p: Record<string, unknown>) => op('budget_transactions_update', { id, budget_id: B, patch: p });
const del = (id: string) => op('budget_transactions_delete', { id, budget_id: B });
const create = (over: Record<string, unknown>) =>
  op('budget_transactions_create', {
    budget_id: B,
    txn: {
      account_id: itau,
      date: daysAgo(1),
      payee: 'Padaria',
      category_id: null,
      memo: 'm',
      outflow: 500_000,
      inflow: 0,
      cleared: 'uncleared',
      approved: true,
      flag: null,
      repeat: 'never',
      ...over,
    },
  });

/** Bank-sync a PIX pair Itau -> Nubank; both rows end up linked by the matcher. */
async function linkedPair(prefix: string, milli = 3_000_000) {
  upstream = {
    [EXT_ITAU]: [txn(EXT_ITAU, `${prefix}-i`, -milli, 'Pix enviado Yuri', SAME_PERSON)],
    [EXT_NU]: [txn(EXT_NU, `${prefix}-n`, milli, 'Transferência Recebida', SAME_PERSON)],
  };
  await sync();
  const out = await byImport(`${PROVIDER}:${prefix}-i`);
  const inn = await byImport(`${PROVIDER}:${prefix}-n`);
  expect(out.transfer_transaction_id).toBe(inn.id);
  expect(inn.transfer_transaction_id).toBe(out.id);
  return { out, inn, milli };
}

describe.skipIf(!dbReady)('transfer integrity (budget-nq2f)', () => {
  beforeAll(async () => {
    await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
    await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [B, 'nq2f-integrity', user.id]);
    await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [B, user.id]);
    await pool.query(
      `INSERT INTO accounts (id, budget_id, name, type, account_group, on_budget) VALUES
       ($1,$5,'Itau Conta','checking','CASH',true),($2,$5,'Nubank Conta','checking','CASH',true),
       ($3,$5,'Third Conta','checking','CASH',true),($4,$5,'House Tracking','checking','CASH',false)`,
      [itau, nubank, third, house, B],
    );
    // Every account has its transfer payee, as POST /accounts makes it.
    for (const [id, name] of [[itau, 'Itau Conta'], [nubank, 'Nubank Conta'], [third, 'Third Conta'], [house, 'House Tracking']] as const) {
      const p = await pool.query<{ id: string }>(
        'INSERT INTO payees (budget_id, name, transfer_account_id) VALUES ($1,$2,$3) RETURNING id',
        [B, `Transfer : ${name}`, id],
      );
      await pool.query('UPDATE accounts SET transfer_payee_id = $1 WHERE id = $2', [p.rows[0]!.id, id]);
    }
    await pool.query('INSERT INTO category_groups (id, budget_id, name) VALUES ($1,$2,$3)', [groupId, B, 'G']);
    await pool.query('INSERT INTO categories (id, budget_id, group_id, name) VALUES ($1,$2,$3,$4)', [categoryId, B, groupId, 'Gifts']);
    const c = await store.upsertConnection({
      userId: user.id,
      provider: PROVIDER,
      externalId: EXT_ITEM,
      clientUserId: `cu-${user.id}`,
      status: 'connected',
      environment: 'production',
    });
    connId = c.id;
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [connId, EXT_ITAU, itau, 'itau']);
    await pool.query('UPDATE accounts SET connection_id = $1, external_account_id = $2, institution = $4 WHERE id = $3', [connId, EXT_NU, nubank, 'Nu Pagamentos S.A.']);
  });
  afterAll(async () => {
    await pool.query('DELETE FROM budgets WHERE id = $1', [B]);
    await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
  });

  describe('R1: a leg leaving a matcher-linked pair restores the other bank row', () => {
    test('editing the payee of one leg to an ordinary payee restores the other, keeps its bank id, and later syncs neither skip nor duplicate it', async () => {
      await reset();
      const { out, inn, milli } = await linkedPair('r1a');
      const before = await balances(nubank);
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);

      const restored = await row(inn.id);
      expect(restored).toMatchObject({
        deleted: false,
        transfer_account_id: null,
        transfer_transaction_id: null,
        payee: 'Transferência Recebida', // the bank's payee, what it was before linking
        import_id: `${PROVIDER}:r1a-n`,
        mark: 'manual', // suggested again, never re-linked on its own (as Undo does)
        blocked: false, // the shadow is unfrozen: it was not blocked before the link
      });
      expect(restored.amount).toBe(milli);
      expect(await balances(nubank)).toEqual(before); // nothing moved
      const edited = await row(out.id);
      expect(edited).toMatchObject({ payee: 'Padaria', transfer_account_id: null, transfer_transaction_id: null, deleted: false });
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_links WHERE budget_id = $1', [B])).rows[0].n).toBe(0);
      await expectLedgerConsistent();

      // Later syncs: the bank id is neither skipped (a deleted row would be) nor imported twice.
      const snapshot = await rowsOf();
      const result = await sync();
      await sync();
      expect(await rowsOf()).toEqual(snapshot);
      expect(result.added).toBe(0);
      expect(result.skipped_deleted).toBe(0);
    });

    test('deleting one leg restores the other (either side), instead of deleting it', async () => {
      for (const side of ['outflow', 'inflow'] as const) {
        await reset();
        const { out, inn } = await linkedPair(`r1b-${side}`);
        const [victim, other] = side === 'outflow' ? [out, inn] : [inn, out];
        const before = [await balances(other.account_id)];
        expect((await del(victim.id)).status).toBe(204);
        expect((await row(victim.id)).deleted).toBe(true);
        const kept = await row(other.id);
        expect(kept).toMatchObject({ deleted: false, transfer_account_id: null, transfer_transaction_id: null, import_id: other.import_id, mark: 'manual' });
        expect(kept.payee).toBe(side === 'outflow' ? 'Transferência Recebida' : 'Pix enviado Yuri');
        expect([await balances(other.account_id)]).toEqual(before);
        await expectLedgerConsistent();
        // The bank id of the surviving row is not imported again; the deleted one stays deleted.
        const snapshot = await rowsOf();
        const result = await sync();
        expect(await rowsOf()).toEqual(snapshot);
        expect(result.added).toBe(0);
      }
    });

    test('moving a leg to another peer restores the old mirror and mirrors into the new peer', async () => {
      await reset();
      const { out, inn } = await linkedPair('r1c');
      expect((await patch(out.id, { payee: 'Transfer : Third Conta' })).status).toBe(204);
      expect(await row(inn.id)).toMatchObject({ deleted: false, transfer_transaction_id: null, payee: 'Transferência Recebida' });
      const moved = await row(out.id);
      expect(moved.transfer_account_id).toBe(third);
      const mirror = (await rowsOf(third)).find((r) => !r.deleted)!;
      expect(mirror).toMatchObject({ amount: 3_000_000, transfer_transaction_id: out.id, transfer_account_id: itau });
      expect(mirror.import_id).toBeNull();
      await expectLedgerConsistent();
    });

    test('a link made by hand ("Other account...") whose mirror was created is still removed with the leg', async () => {
      await reset();
      const made = await create({ payee: 'Transfer : Third Conta', outflow: 70_000 });
      expect(made.status).toBe(201);
      const leg = made.json.id as string;
      const mirrorId = (await row(leg)).transfer_transaction_id!;
      expect((await del(leg)).status).toBe(204);
      expect((await row(mirrorId)).deleted).toBe(true);
      expect(await balances(third)).toEqual([0, 0]);
      await expectLedgerConsistent();
    });
  });

  describe('R2 is not automatic: a hand-entered transfer plus a bank import of the other side stays two rows, as on main', () => {
    test('the bank row is left as it is, the hand-made mirror stays, nothing is merged or deleted, and re-syncs change nothing', async () => {
      await reset();
      const date = daysAgo(1);
      const made = await create({ payee: 'Transfer : Nubank Conta', outflow: 500_000, date });
      const handMirror = (await row(made.json.id)).transfer_transaction_id!;
      upstream = { [EXT_NU]: [txn(EXT_NU, 'r2-n', 500_000, 'Transferência Recebida', {}, date)] };
      await sync();
      const bank = await byImport(`${PROVIDER}:r2-n`);
      expect(bank).toMatchObject({ transfer_transaction_id: null, transfer_account_id: null, deleted: false, payee: 'Transferência Recebida' });
      expect((await row(handMirror)).deleted).toBe(false);
      expect((await rowsOf(nubank)).filter((r) => !r.deleted)).toHaveLength(2);
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_links WHERE budget_id = $1', [B])).rows[0].n).toBe(0);
      const snapshot = await rowsOf();
      await sync();
      expect(await rowsOf()).toEqual(snapshot);
    });
  });

  describe('imports never store a transfer payee without the transfer: a hint for the matcher instead', () => {
    test('statement import: "Transfer : <account>" text stays an ordinary row, is suggested for that account, and links when the other side arrives', async () => {
      await reset();
      const res = await op('budget_transactions_bulk_import', {
        budget_id: B,
        account_id: itau,
        txns: [{ date: daysAgo(2), payee: 'Transfer : Nubank Conta', memo: '', outflow: 250_000, inflow: 0, category_id: null }],
      });
      expect(res.status).toBe(201);
      const [r] = (await rowsOf(itau)).filter((x) => !x.deleted);
      expect(r).toMatchObject({ payee: null, transfer_account_id: null, transfer_transaction_id: null, category_id: null });
      const hint = (await pool.query('SELECT account_id FROM transfer_hints WHERE transaction_id = $1', [r!.id])).rows[0];
      expect(hint.account_id).toBe(nubank);
      // No mirror was invented: the other side may come from the other bank.
      expect((await rowsOf(nubank)).filter((x) => !x.deleted)).toHaveLength(0);
      expect(await balances(nubank)).toEqual([0, 0]);
      // The matcher offers it as a strong suggestion (one side).
      const list = await op('budget_transactions_list', { budget_id: B });
      expect(list.json.find((x: { id: string }) => x.id === r!.id).transfer_suggestion).toMatchObject({ confidence: 'one_side' });

      // The other side arrives from the other bank: they pair, the hint is gone.
      const other = await op('budget_transactions_bulk_import', {
        budget_id: B,
        account_id: nubank,
        txns: [{ date: daysAgo(2), payee: 'Recebido', memo: '', outflow: 0, inflow: 250_000, category_id: null }],
      });
      expect(other.status).toBe(201);
      const linked = await row(r!.id);
      expect(linked.transfer_account_id).toBe(nubank);
      expect(linked.payee).toBe('Transfer : Nubank Conta');
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_hints WHERE budget_id = $1', [B])).rows[0].n).toBe(0);
      // Re-importing the same file stays idempotent.
      const again = await op('budget_transactions_bulk_import', {
        budget_id: B,
        account_id: itau,
        txns: [{ date: daysAgo(2), payee: 'Transfer : Nubank Conta', memo: '', outflow: 250_000, inflow: 0, category_id: null }],
      });
      expect(again.json).toEqual({ imported: 0, duplicates: 1 });
    });

    test('bank sync: a renaming rule on a transfer payee does not leave a payee-only half transfer', async () => {
      await reset();
      const payeeId = (await pool.query('SELECT transfer_payee_id AS id FROM accounts WHERE id = $1', [nubank])).rows[0].id as string;
      expect((await op('budget_payees_set_rename_rule', { id: payeeId, budget_id: B, match_type: 'is', condition: 'PIX NUBANK' })).status).toBe(204);
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'h1-i', -90_000, 'PIX NUBANK')] };
      await sync();
      await sync();
      const [r] = (await rowsOf(itau)).filter((x) => !x.deleted);
      expect(r).toMatchObject({ payee: 'PIX NUBANK', transfer_account_id: null, transfer_transaction_id: null, blocked: false });
      expect((await pool.query('SELECT account_id FROM transfer_hints WHERE transaction_id = $1', [r!.id])).rows[0].account_id).toBe(nubank);
      expect((await rowsOf(nubank)).filter((x) => !x.deleted)).toHaveLength(0);
      const list = await op('budget_transactions_list', { budget_id: B });
      expect(list.json.find((x: { id: string }) => x.id === r!.id).transfer_suggestion).toMatchObject({ confidence: 'one_side' });

      // The real other side arrives on a later sync: linked, and the text is remembered nowhere else.
      upstream = { ...upstream, [EXT_NU]: [txn(EXT_NU, 'h1-n', 90_000, 'Transferência Recebida')] };
      await sync();
      const linked = await row(r!.id);
      expect(linked.transfer_account_id).toBe(nubank);
      expect(linked.transfer_transaction_id).not.toBeNull();
      await expectLedgerConsistent();
    });
  });

  describe('no category on a leg of an on-budget pair, whatever wrote it', () => {
    test('a category patched onto a payee-only transfer leg is dropped; a leg to an off-budget account keeps its category', async () => {
      await reset();
      const payee = (await pool.query('SELECT transfer_payee_id AS id FROM accounts WHERE id = $1', [nubank])).rows[0].id as string;
      const legacy = (
        await pool.query<{ id: string }>(
          `INSERT INTO transactions (budget_id, account_id, date, amount, payee_id, cleared, approved, repeat, deleted)
           VALUES ($1,$2,$3,-1000,$4,'uncleared',true,'never',false) RETURNING id`,
          [B, itau, daysAgo(1), payee],
        )
      ).rows[0]!.id;
      // A payee-only leg from main (no pointers) is not a pair here: an edit leaves its category as main does.
      expect((await patch(legacy, { category_id: categoryId })).status).toBe(204);
      expect((await row(legacy)).category_id).toBe(categoryId);
      expect((await patch(legacy, { memo: 'unrelated' })).status).toBe(204);
      expect((await patch(legacy, { date: daysAgo(3) })).status).toBe(204);
      expect(await row(legacy)).toMatchObject({ category_id: categoryId, transfer_account_id: null, transfer_transaction_id: null });
      // A leg that IS part of a pair loses a category sent with any edit.
      const made = await create({ payee: 'Transfer : Third Conta', outflow: 11_000 });
      expect((await patch(made.json.id, { category_id: categoryId })).status).toBe(204);
      expect((await row(made.json.id)).category_id).toBeNull();

      const toHouse = await create({ payee: 'Transfer : House Tracking', category_id: categoryId, outflow: 20_000 });
      expect(toHouse.status).toBe(201);
      expect((await row(toHouse.json.id)).category_id).toBe(categoryId);
      expect((await patch(toHouse.json.id, { memo: 'still' })).status).toBe(204);
      expect((await row(toHouse.json.id)).category_id).toBe(categoryId);
    });
  });

  describe('a bank sync never rewrites a row that is correct as it was stored', () => {
    const tp = async (acc: string) => (await pool.query('SELECT transfer_payee_id AS id FROM accounts WHERE id = $1', [acc])).rows[0].id as string;
    const readyToAssignInput = async () => ({ rows: await rowsOf(), balances: [await balances(itau), await balances(nubank)] });

    /** A row as the sync of the previous release stored it: the transfer payee, the shadow payload saying so. */
    async function mainEraRow(importSuffix: string, text: string) {
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, importSuffix, -40_000, text)] };
      await sync();
      const r0 = await byImport(`${PROVIDER}:${importSuffix}`);
      await pool.query('UPDATE transactions SET payee_id = $2, import_payee_name = $3, import_payee_name_original = $3 WHERE id = $1', [r0.id, await tp(nubank), text]);
      await pool.query(
        `UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload::jsonb, '{payee}', to_jsonb($2::text))::json WHERE transaction_id = $1`,
        [r0.id, text],
      ).catch(() =>
        pool.query(`UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload, '{payee}', to_jsonb($2::text)) WHERE transaction_id = $1`, [r0.id, text]),
      );
      await pool.query('DELETE FROM transfer_hints WHERE transaction_id = $1', [r0.id]);
      return r0.id;
    }

    test('a payee-only transfer row of an earlier sync (the text names the account) keeps its payee on every later sync', async () => {
      await reset();
      const id = await mainEraRow('b1-text', 'Transfer : Nubank Conta');
      const before = await readyToAssignInput();
      const first = await sync();
      const second = await sync();
      expect(await readyToAssignInput()).toEqual(before);
      expect(first.updated + second.updated).toBe(0);
      expect(await row(id)).toMatchObject({ payee: 'Transfer : Nubank Conta', transfer_account_id: null });
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_hints WHERE transaction_id = $1', [id])).rows[0].n).toBe(0);
    });

    test('the same through a renaming rule, and when the bank changes the amount the row keeps its payee', async () => {
      await reset();
      const payee = await tp(nubank);
      expect((await op('budget_payees_set_rename_rule', { id: payee, budget_id: B, match_type: 'is', condition: 'PIX NUBANK B1' })).status).toBe(204);
      const id = await mainEraRow('b1-rule', 'PIX NUBANK B1');
      // The earlier sync stored the rule-rewritten text as the import name and in the shadow.
      await pool.query(`UPDATE transactions SET import_payee_name = 'Transfer : Nubank Conta', import_payee_name_original = 'Transfer : Nubank Conta' WHERE id = $1`, [id]);
      await pool.query(
        `UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload::jsonb, '{payee}', '"Transfer : Nubank Conta"')::json WHERE transaction_id = $1`,
        [id],
      ).catch(() =>
        pool.query(`UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload, '{payee}', '"Transfer : Nubank Conta"') WHERE transaction_id = $1`, [id]),
      );
      const before = await readyToAssignInput();
      await sync();
      expect(await readyToAssignInput()).toEqual(before);
      // The bank corrects the amount: the row is refreshed (as on main) and still keeps the transfer payee.
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'b1-rule', -45_000, 'PIX NUBANK B1')] };
      const res = await sync();
      expect(res.updated).toBe(1);
      expect(await row(id)).toMatchObject({ payee: 'Transfer : Nubank Conta', amount: -45_000 });
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_hints WHERE transaction_id = $1', [id])).rows[0].n).toBe(0);
      await sync();
      expect((await row(id)).payee).toBe('Transfer : Nubank Conta');
    });

    test('a NEW row of the same text follows the new path, keeps the bank text in its import name, and later syncs leave it alone', async () => {
      await reset();
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'b1-new', -40_000, 'Transfer : Nubank Conta')] };
      await sync();
      const r = await byImport(`${PROVIDER}:b1-new`);
      expect(r).toMatchObject({ payee: null, transfer_account_id: null });
      // Follow-up: the imported text is not lost when no payee is stored.
      const meta = (await pool.query('SELECT import_payee_name AS n FROM transactions WHERE id = $1', [r.id])).rows[0];
      expect(meta.n).toBe('Transfer : Nubank Conta');
      const hint = (await pool.query('SELECT account_id FROM transfer_hints WHERE transaction_id = $1', [r.id])).rows[0];
      expect(hint.account_id).toBe(nubank);
      const before = await rowsOf();
      const res = await sync();
      await sync();
      expect(await rowsOf()).toEqual(before);
      expect(res.updated).toBe(0);
      // When the bank changes the amount the row is refreshed and keeps its hint.
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'b1-new', -41_000, 'Transfer : Nubank Conta')] };
      expect((await sync()).updated).toBe(1);
      expect((await pool.query('SELECT account_id FROM transfer_hints WHERE transaction_id = $1', [r.id])).rows[0].account_id).toBe(nubank);
      // And when the text stops naming an account the hint goes.
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, 'b1-new', -41_000, 'Padaria do Ze')] };
      expect((await sync()).updated).toBe(1);
      expect((await pool.query('SELECT count(*)::int AS n FROM transfer_hints WHERE transaction_id = $1', [r.id])).rows[0].n).toBe(0);
      expect(await row(r.id)).toMatchObject({ payee: 'Padaria do Ze' });
    });

    test('re-syncing rows main stored through a renaming rule creates no payee (one per run was created before)', async () => {
      await reset();
      const payee = await tp(nubank);
      expect((await op('budget_payees_set_rename_rule', { id: payee, budget_id: B, match_type: 'is', condition: 'PIX NUBANK F3' })).status).toBe(204);
      const id = await mainEraRow('f3', 'PIX NUBANK F3');
      await pool.query(`UPDATE transactions SET import_payee_name = 'Transfer : Nubank Conta', import_payee_name_original = 'Transfer : Nubank Conta' WHERE id = $1`, [id]);
      await pool.query(
        `UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload::jsonb, '{payee}', '"Transfer : Nubank Conta"')::json WHERE transaction_id = $1`,
        [id],
      ).catch(() =>
        pool.query(`UPDATE connection_transactions SET last_synced_payload = jsonb_set(last_synced_payload, '{payee}', '"Transfer : Nubank Conta"') WHERE transaction_id = $1`, [id]),
      );
      // The ordinary payee the first (insert) sync made is unreferenced now: a re-sync must not bring it back.
      await pool.query("DELETE FROM payees WHERE budget_id = $1 AND name = 'PIX NUBANK F3'", [B]);
      const payeeNames = async () => (await pool.query('SELECT name FROM payees WHERE budget_id = $1 ORDER BY name', [B])).rows;
      await sync();
      const before = await payeeNames();
      await sync();
      await sync();
      expect(await payeeNames()).toEqual(before);
      expect(before.map((r) => r.name)).not.toContain('PIX NUBANK F3');
      expect(await row(id)).toMatchObject({ payee: 'Transfer : Nubank Conta' });
    });
  });

  describe('a hint ends with the question it asked', () => {
    async function hinted(suffix: string) {
      await reset();
      upstream = { [EXT_ITAU]: [txn(EXT_ITAU, suffix, -30_000, 'Transfer : Nubank Conta')] };
      await sync();
      const r = await byImport(`${PROVIDER}:${suffix}`);
      const has = async () => (await pool.query('SELECT count(*)::int AS n FROM transfer_hints WHERE transaction_id = $1', [r.id])).rows[0].n === 1;
      expect(await has()).toBe(true);
      return { r, has };
    }
    test('a category ends it', async () => {
      const { r, has } = await hinted('h5-cat');
      expect((await patch(r.id, { category_id: categoryId })).status).toBe(204);
      expect(await has()).toBe(false);
    });
    test('another payee ends it', async () => {
      const { r, has } = await hinted('h5-payee');
      expect((await patch(r.id, { payee: 'Padaria' })).status).toBe(204);
      expect(await has()).toBe(false);
    });
    test('"not a transfer" (and "outside") end it', async () => {
      for (const state of ['dismissed', 'outside'] as const) {
        const { r, has } = await hinted(`h5-${state}`);
        expect((await op('budget_transfers_mark', { budget_id: B, transaction_ids: [r.id], state })).status).toBe(200);
        expect(await has()).toBe(false);
      }
    });
    test('an edit that changes nothing about the payee keeps it', async () => {
      const { r, has } = await hinted('h5-memo');
      expect((await patch(r.id, { memo: 'only a note' })).status).toBe(204);
      expect(await has()).toBe(true);
    });
  });

  describe('releasing a leg and making it a transfer again', () => {
    test('does not count the account twice: the released bank row is linked again, no mirror is added, unlink works on it', async () => {
      await reset();
      const { out, inn } = await linkedPair('f2');
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);
      const afterRelease = await balances(nubank);
      expect((await patch(out.id, { payee: 'Transfer : Nubank Conta' })).status).toBe(204);
      const live = (await rowsOf(nubank)).filter((r) => !r.deleted);
      expect(live.map((r) => r.id)).toEqual([inn.id]); // one row, not two
      expect(live[0]).toMatchObject({ transfer_transaction_id: out.id, transfer_account_id: itau, import_id: `${PROVIDER}:f2-n` });
      expect(await row(out.id)).toMatchObject({ transfer_transaction_id: inn.id, transfer_account_id: nubank });
      expect(await balances(nubank)).toEqual(afterRelease);
      await expectLedgerConsistent();
      const snapshot = await rowsOf();
      await sync();
      expect(await rowsOf()).toEqual(snapshot);
      const undo = await op('budget_transfers_unlink', { budget_id: B, transaction_ids: [inn.id] });
      expect(undo.json).toMatchObject({ unlinked: 1 });
    });
    test('another amount still gets its own mirror', async () => {
      await reset();
      const { out } = await linkedPair('f2b');
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);
      expect((await patch(out.id, { payee: 'Transfer : Nubank Conta', outflow: 1_000_000 })).status).toBe(204);
      const live = (await rowsOf(nubank)).filter((r) => !r.deleted);
      expect(live).toHaveLength(2);
      await expectLedgerConsistent();
    });

    test('a row the person unlinked on purpose is NOT re-linked when another row becomes a transfer (their mark and payee stay)', async () => {
      await reset();
      const { out, inn } = await linkedPair('q4', 200_000);
      expect((await op('budget_transfers_unlink', { budget_id: B, transaction_ids: [out.id] })).json).toMatchObject({ unlinked: 1 });
      const unlinkedBefore = await row(inn.id);
      expect(unlinkedBefore.mark).toBe('manual');
      const other = await create({ payee: 'Padaria', outflow: 200_000, date: daysAgo(2) });
      expect((await patch(other.json.id, { payee: 'Transfer : Nubank Conta' })).status).toBe(204);
      expect(await row(inn.id)).toEqual(unlinkedBefore);
      const mirror = (await rowsOf(nubank)).find((r) => r.transfer_transaction_id === other.json.id)!;
      expect(mirror.import_id).toBeNull(); // a mirror was created, as on main
      await expectLedgerConsistent();
    });

    test('only the leg that released the row re-links it: another leg of the same amount gets a mirror', async () => {
      await reset();
      const { out, inn } = await linkedPair('q4b', 300_000);
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);
      const other = await create({ payee: 'Padaria', outflow: 300_000, date: daysAgo(1) });
      expect((await patch(other.json.id, { payee: 'Transfer : Nubank Conta' })).status).toBe(204);
      expect((await row(inn.id)).transfer_transaction_id).toBeNull();
      expect((await rowsOf(nubank)).filter((r) => !r.deleted)).toHaveLength(2);
      await expectLedgerConsistent();
    });

    test('the released row was edited since the release: it is not re-linked, a mirror is created', async () => {
      await reset();
      const { out, inn } = await linkedPair('q4c', 400_000);
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);
      expect((await patch(inn.id, { memo: 'I touched it' })).status).toBe(204);
      expect((await patch(out.id, { payee: 'Transfer : Nubank Conta' })).status).toBe(204);
      expect(await row(inn.id)).toMatchObject({ transfer_transaction_id: null });
      expect((await rowsOf(nubank)).filter((r) => !r.deleted)).toHaveLength(2);
      await expectLedgerConsistent();
    });

    test('the released row was marked "not a transfer" or unlinked/linked since: it is not re-linked', async () => {
      await reset();
      const { out, inn } = await linkedPair('q4d', 500_000);
      expect((await patch(out.id, { payee: 'Padaria' })).status).toBe(204);
      expect((await op('budget_transfers_mark', { budget_id: B, transaction_ids: [inn.id], state: 'dismissed' })).status).toBe(200);
      expect((await patch(out.id, { payee: 'Transfer : Nubank Conta' })).status).toBe(204);
      expect(await row(inn.id)).toMatchObject({ transfer_transaction_id: null, mark: 'dismissed' });
      expect((await rowsOf(nubank)).filter((r) => !r.deleted)).toHaveLength(2);
    });
  });

});
