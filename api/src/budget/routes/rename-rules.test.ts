/**
 * Renaming rules of a payee (budget-mkrt, transfers T3b): several per payee, four
 * match types, the operations that list / add / change / remove them, and the
 * single-rule operation the released clients still use.
 *
 * Through the operations (contract paths), in process, DB-gated. Every test makes
 * its own budget; budgets are deleted in afterAll.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

import { contracts } from '../../catalog';
import { pool } from '../../core/db';
import { dbReady } from '../../core/test-gate';
import { makeOpCaller } from '../../core/test-op';
import { httpOnError } from '../../core/validate';
import type { IdentityUser } from '../../user';
import budget from '../index';

const user: IdentityUser = { id: crypto.randomUUID(), email: 'rename-rules@syscd.local', googleSub: null, role: 'user', status: 'active' };
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  c.set('user', user);
  return next();
});
app.route('/', budget);
const op = makeOpCaller(app, contracts);

const budgets: string[] = [];
async function newBudget(): Promise<string> {
  const id = crypto.randomUUID();
  await pool.query('INSERT INTO budgets (id, name, owner_user_id) VALUES ($1,$2,$3)', [id, 'rename-rules', user.id]);
  await pool.query('INSERT INTO budget_members (budget_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, user.id]);
  budgets.push(id);
  return id;
}
async function payee(b: string, name: string): Promise<string> {
  const res = await op('budget_payees_create', { budget_id: b, name });
  expect(res.status).toBe(201);
  return res.json.id as string;
}
const add = (b: string, id: string, match_type: string, condition: string) => op('budget_payees_rename_rules_add', { id, budget_id: b, match_type, condition });
const list = async (b: string, id: string) => {
  const res = await op('budget_payees_rename_rules_list', { id, budget_id: b });
  expect(res.status).toBe(200);
  return res.json as { id: string; payee_id: string; match_type: string; condition: string; created_at: string }[];
};
const columns = async (id: string) => (await pool.query('SELECT rename_match_type AS t, rename_condition AS c FROM payees WHERE id = $1', [id])).rows[0] as { t: string | null; c: string | null };
const payeeRow = async (b: string, id: string) => {
  const res = await op('budget_payees_list', { budget_id: b, include_transfers: 'true' });
  return (res.json as Record<string, unknown>[]).find((p) => p.id === id)!;
};

beforeAll(async () => {
  if (!dbReady) return;
  await pool.query(`INSERT INTO users (id, google_sub, email, role, status) VALUES ($1,$2,$3,'user','active')`, [user.id, user.id, user.email]);
});
afterAll(async () => {
  if (!dbReady) return;
  await pool.query('DELETE FROM budgets WHERE id = ANY($1)', [budgets]);
  await pool.query('DELETE FROM users WHERE id = $1', [user.id]);
});

describe.skipIf(!dbReady)('renaming rules: several per payee', () => {
  test('add, list oldest first, update, remove; all four match types; the condition is trimmed', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Padaria');
    for (const [type, cond] of [['is', 'PADOCA'], ['contains', 'pao quente'], ['starts_with', 'PAD '], ['ends_with', ' sp']] as const) {
      const res = await add(b, p, type, `  ${cond}  `);
      expect(res.status, JSON.stringify(res.json)).toBe(201);
      expect(res.json).toMatchObject({ payee_id: p, match_type: type, condition: cond.trim() });
    }
    const rules = await list(b, p);
    expect(rules.map((r) => [r.match_type, r.condition])).toEqual([['is', 'PADOCA'], ['contains', 'pao quente'], ['starts_with', 'PAD'], ['ends_with', 'sp']]);

    const changed = await op('budget_payees_rename_rules_update', { id: p, budget_id: b, rule_id: rules[2]!.id, match_type: 'starts_with', condition: 'PADARIA ' });
    expect(changed.status).toBe(200);
    expect(changed.json).toMatchObject({ id: rules[2]!.id, match_type: 'starts_with', condition: 'PADARIA', created_at: rules[2]!.created_at });
    expect((await op('budget_payees_rename_rules_remove', { id: p, budget_id: b, rule_id: rules[0]!.id })).status).toBe(204);
    expect((await list(b, p)).map((r) => r.condition)).toEqual(['pao quente', 'PADARIA', 'sp']);
    // Gone is gone.
    expect((await op('budget_payees_rename_rules_remove', { id: p, budget_id: b, rule_id: rules[0]!.id })).status).toBe(404);
  });

  test('validation: blank text, unknown type and an unknown payee are refused', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Validate');
    expect((await add(b, p, 'contains', '   ')).status).toBe(400);
    expect((await add(b, p, 'regex', 'x')).status).toBe(400);
    expect((await add(b, crypto.randomUUID(), 'is', 'x')).status).toBe(404);
    expect((await op('budget_payees_rename_rules_list', { id: crypto.randomUUID(), budget_id: b })).status).toBe(404);
    expect(await list(b, p)).toEqual([]);
  });

  test('a rule belongs to one payee: the same type and text (case and spaces ignored) is a 409 naming the holder; another type is fine', async () => {
    const b = await newBudget();
    const one = await payee(b, 'One');
    const two = await payee(b, 'Two');
    expect((await add(b, one, 'contains', 'Pix   Loja')).status).toBe(201);
    for (const holder of [one, two]) {
      const clash = await add(b, holder, 'contains', ' pix loja ');
      expect(clash.status).toBe(409);
      expect(clash.json).toMatchObject({ code: 'rename_rule_exists', params: { name: 'One' } });
    }
    expect((await add(b, two, 'starts_with', 'pix loja')).status).toBe(201);
    // An update that would collide is refused; one that changes nothing about its own text is not.
    const r = (await list(b, two))[0]!;
    expect((await op('budget_payees_rename_rules_update', { id: two, budget_id: b, rule_id: r.id, match_type: 'contains', condition: 'PIX LOJA' })).status).toBe(409);
    expect((await op('budget_payees_rename_rules_update', { id: two, budget_id: b, rule_id: r.id, match_type: 'starts_with', condition: 'PIX  LOJA' })).status).toBe(200);
    // Another budget may hold the same rule.
    const other = await newBudget();
    expect((await add(other, await payee(other, 'One'), 'contains', 'pix loja')).status).toBe(201);
  });

  test('scoping: a rule is reached only through its own payee in its own budget', async () => {
    const b = await newBudget();
    const other = await newBudget();
    const mine = await payee(b, 'Mine');
    const sibling = await payee(b, 'Sibling');
    const foreign = await payee(other, 'Foreign');
    const rule = (await (await add(b, mine, 'is', 'MINE')).json).id as string;
    const foreignRule = (await (await add(other, foreign, 'is', 'FOREIGN')).json).id as string;
    // The payee of another budget, with my budget id: not found, nothing written.
    expect((await add(b, foreign, 'is', 'X')).status).toBe(404);
    expect((await op('budget_payees_rename_rules_list', { id: foreign, budget_id: b })).status).toBe(404);
    // A rule through another payee, or from another budget: not found, untouched.
    expect((await op('budget_payees_rename_rules_update', { id: sibling, budget_id: b, rule_id: rule, match_type: 'is', condition: 'HIJACK' })).status).toBe(404);
    expect((await op('budget_payees_rename_rules_remove', { id: sibling, budget_id: b, rule_id: rule })).status).toBe(404);
    expect((await op('budget_payees_rename_rules_update', { id: mine, budget_id: b, rule_id: foreignRule, match_type: 'is', condition: 'HIJACK' })).status).toBe(404);
    expect((await op('budget_payees_rename_rules_remove', { id: mine, budget_id: b, rule_id: foreignRule })).status).toBe(404);
    expect((await list(b, mine)).map((r) => r.condition)).toEqual(['MINE']);
    expect((await list(other, foreign)).map((r) => r.condition)).toEqual(['FOREIGN']);
  });

  test('a transfer payee holds rules too (it still cannot be renamed, merged, hidden or deleted)', async () => {
    const b = await newBudget();
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Rules Conta', type: 'checking', on_budget: true, balance: 0 });
    expect(acc.status).toBe(201);
    const list0 = (await op('budget_payees_list', { budget_id: b, include_transfers: 'true' })).json as { id: string; name: string; transfer_account_id: string | null }[];
    const transfer = list0.find((p) => p.transfer_account_id === acc.json.id)!;
    expect((await add(b, transfer.id, 'contains', 'PIX SAVINGS')).status).toBe(201);
    expect((await add(b, transfer.id, 'starts_with', 'TED SAV')).status).toBe(201);
    expect((await list(b, transfer.id)).map((r) => r.condition)).toEqual(['PIX SAVINGS', 'TED SAV']);
    expect((await op('budget_payees_delete', { id: transfer.id, budget_id: b })).status).toBe(409);
    expect(((await payeeRow(b, transfer.id)).rename_rules as unknown[]).length).toBe(2);
  });

  test('the payee list carries every rule, and the single-rule fields show the first "is" / "contains" one', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Listed');
    await add(b, p, 'starts_with', 'LIS');
    await add(b, p, 'contains', 'listed co');
    await add(b, p, 'is', 'LISTED');
    const row = await payeeRow(b, p);
    expect(row).toMatchObject({ rename_match_type: 'contains', rename_condition: 'listed co' });
    expect((row.rename_rules as { match_type: string }[]).map((r) => r.match_type)).toEqual(['starts_with', 'contains', 'is']);
    expect(row.rename_rules as unknown[]).toHaveLength(3);
    // A payee with only anchored rules shows none in the released fields.
    const q = await payee(b, 'Anchored');
    await add(b, q, 'ends_with', 'ANCH');
    expect(await payeeRow(b, q)).toMatchObject({ rename_match_type: null, rename_condition: null });
  });
});

describe.skipIf(!dbReady)('renaming rules: the single-rule operation of the released clients', () => {
  const set = (b: string, id: string, match_type: string, condition: string) => op('budget_payees_set_rename_rule', { id, budget_id: b, match_type, condition });

  test('sets, changes and clears the first is/contains rule, same input and output as before, and leaves the other rules alone', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Legacy');
    expect((await set(b, p, 'contains', 'UBER')).status).toBe(204);
    expect(await payeeRow(b, p)).toMatchObject({ rename_match_type: 'contains', rename_condition: 'UBER' });
    // Another rule of the payee, added through the new operations.
    expect((await add(b, p, 'starts_with', 'UBER *')).status).toBe(201);
    // Changing the single rule changes THAT rule, it does not add one.
    expect((await set(b, p, 'is', 'UBER BR')).status).toBe(204);
    expect((await list(b, p)).map((r) => [r.match_type, r.condition])).toEqual([['is', 'UBER BR'], ['starts_with', 'UBER *']]);
    expect(await payeeRow(b, p)).toMatchObject({ rename_match_type: 'is', rename_condition: 'UBER BR' });
    // An empty condition clears it (only it).
    expect((await set(b, p, 'contains', '')).status).toBe(204);
    expect((await list(b, p)).map((r) => [r.match_type, r.condition])).toEqual([['starts_with', 'UBER *']]);
    expect(await payeeRow(b, p)).toMatchObject({ rename_match_type: null, rename_condition: null });
    // Clearing when there is none is fine; an unknown payee is a 404.
    expect((await set(b, p, 'contains', '')).status).toBe(204);
    expect((await set(b, crypto.randomUUID(), 'is', 'X')).status).toBe(404);
    // The old input shape still refuses the new types.
    expect((await set(b, p, 'starts_with', 'X')).status).toBe(400);
  });

  test('the same text on another payee is a 409 (it was a unique violation before)', async () => {
    const b = await newBudget();
    const one = await payee(b, 'First');
    const two = await payee(b, 'Second');
    expect((await set(b, one, 'is', 'DUP')).status).toBe(204);
    const clash = await set(b, two, 'is', 'dup');
    expect(clash.status).toBe(409);
    expect(clash.json).toMatchObject({ code: 'rename_rule_exists' });
  });

  test('the columns on the payee row mirror the first is/contains rule for the other app, whichever call changed it', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Mirror');
    await add(b, p, 'ends_with', 'MIR');
    expect(await columns(p)).toEqual({ t: null, c: null });
    const first = (await (await add(b, p, 'contains', 'mirror shop')).json).id as string;
    expect(await columns(p)).toEqual({ t: 'contains', c: 'mirror shop' });
    await add(b, p, 'is', 'MIRROR');
    expect(await columns(p)).toEqual({ t: 'contains', c: 'mirror shop' }); // the first stays the first
    await op('budget_payees_rename_rules_update', { id: p, budget_id: b, rule_id: first, match_type: 'is', condition: 'mirror shop 2' });
    expect(await columns(p)).toEqual({ t: 'is', c: 'mirror shop 2' });
    await op('budget_payees_rename_rules_remove', { id: p, budget_id: b, rule_id: first });
    expect(await columns(p)).toEqual({ t: 'is', c: 'MIRROR' });
    // Two payees whose first rules read the same text in the old unique column: the second is left empty, not failed.
    const q = await payee(b, 'Mirror twin');
    expect((await add(b, q, 'contains', 'MIRROR')).status).toBe(201);
    expect(await columns(q)).toEqual({ t: null, c: null });
  });
});

describe.skipIf(!dbReady)('renaming rules: payee delete, merge, create and budget copy', () => {
  test('deleting a payee takes its rules; the text is free for another payee', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Doomed');
    await add(b, p, 'is', 'DOOMED TEXT');
    expect((await op('budget_payees_delete', { id: p, budget_id: b })).status).toBe(204);
    expect((await pool.query('SELECT count(*)::int AS n FROM payee_renaming_rules WHERE payee_id = $1', [p])).rows[0].n).toBe(0);
    expect(await columns(p)).toEqual({ t: null, c: null });
    const heir = await payee(b, 'Heir');
    expect((await add(b, heir, 'is', 'DOOMED TEXT')).status).toBe(201);
  });

  test('merging moves the rules of the merged payee to the target, so the text keeps resolving to the rows\' payee', async () => {
    const b = await newBudget();
    const from = await payee(b, 'Merge From');
    const to = await payee(b, 'Merge To');
    await add(b, from, 'contains', 'FROM TEXT');
    await add(b, to, 'is', 'TO TEXT');
    const res = await op('budget_payees_merge', { id: from, budget_id: b, target_id: to });
    expect(res.status).toBe(200);
    // Oldest first: the rule that came over keeps its age.
    expect((await list(b, to)).map((r) => r.condition)).toEqual(['FROM TEXT', 'TO TEXT']);
    expect(await columns(from)).toEqual({ t: null, c: null });
    expect(await columns(to)).toEqual({ t: 'contains', c: 'FROM TEXT' });
    // A register entry with the old text now lands on the target.
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Merge Conta', type: 'checking', on_budget: true, balance: 0 });
    const made = await op('budget_transaction_add', { budget_id: b, account_id: acc.json.id, amount: -1000, payee: 'from text 7' });
    expect(made.status).toBe(201);
    expect((await pool.query('SELECT payee_id FROM transactions WHERE id = $1', [made.json.id])).rows[0].payee_id).toBe(to);
  });

  test('creating a payee by a text a rule matches returns the rule\'s payee, whole', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Uber');
    await add(b, p, 'contains', 'UBER');
    const res = await op('budget_payees_create', { budget_id: b, name: 'UBER *TRIP 9' });
    expect(res.json.id).toBe(p);
    expect(res.json.name).toBe('Uber');
  });

  test('a fresh-start copy carries the rules with their payees', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Copied');
    await add(b, p, 'starts_with', 'COP');
    await add(b, p, 'contains', 'copied co');
    const res = await op('budget_fresh_start', { budget_id: b }).catch(() => null);
    if (res && res.status < 300) budgets.push(res.json.created.id);
    expect(res).not.toBeNull();
    const copied = (
      await pool.query<{ match_type: string; condition: string; name: string }>(
        `SELECT r.match_type, r.condition, p.name FROM payee_renaming_rules r JOIN payees p ON p.id = r.payee_id WHERE r.budget_id = $1 ORDER BY r.created_at, r.id`,
        [res!.json.created.id],
      )
    ).rows;
    expect(copied).toEqual([
      { match_type: 'starts_with', condition: 'COP', name: 'Copied' },
      { match_type: 'contains', condition: 'copied co', name: 'Copied' },
    ]);
  });
});

describe.skipIf(!dbReady)('migration 0121: copies the single rules, once', () => {
  const sql = readFileSync(join(import.meta.dir, '..', '..', '..', 'db', 'migrations', '0121_payee_renaming_rules.sql'), 'utf8');

  test('every live payee\'s old rule is copied; a second run changes nothing and does not bring back a removed rule', async () => {
    const b = await newBudget();
    // Payees as main left them: the rule on the payee row only.
    const mk = async (name: string, type: string | null, cond: string | null, deleted = false) =>
      (
        await pool.query<{ id: string }>('INSERT INTO payees (budget_id, name, rename_match_type, rename_condition, deleted) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b, name, type, cond, deleted])
      ).rows[0]!.id;
    const a = await mk('Mig A', 'contains', 'MIG ONE');
    const c = await mk('Mig C', 'contains', '  mig  one ');   // same type and text as A once normalised: A (older) keeps it
    const d = await mk('Mig D', 'is', 'MIG TWO');
    const gone = await mk('Mig Deleted', 'is', 'MIG GONE', true);
    const none = await mk('Mig None', null, null);
    const count = async () => (await pool.query('SELECT payee_id, match_type, condition FROM payee_renaming_rules WHERE budget_id = $1 ORDER BY payee_id', [b])).rows;

    await pool.query(sql);
    const first = await count();
    expect(first.map((r) => r.payee_id).sort()).toEqual([a, d].sort());
    expect(first.find((r) => r.payee_id === a)).toMatchObject({ match_type: 'contains', condition: 'MIG ONE' });
    expect(first.find((r) => r.payee_id === d)).toMatchObject({ match_type: 'is', condition: 'MIG TWO' });
    void c; void gone; void none;

    await pool.query(sql);
    expect(await count()).toEqual(first);
    // A rule removed through the API clears the payee's column as well, so running the file again does not bring it back.
    const rules = await list(b, d);
    expect((await op('budget_payees_rename_rules_remove', { id: d, budget_id: b, rule_id: rules[0]!.id })).status).toBe(204);
    await pool.query(sql);
    expect((await count()).map((r) => r.payee_id)).toEqual([a]);
  });
});
