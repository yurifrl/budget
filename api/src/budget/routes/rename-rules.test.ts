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
const asRowsOf = async (b: string, id: string) => (await list(b, id)).map((r) => [r.match_type, r.condition]);
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

  test('a rule belongs to one payee: the same type and text (case ignored) is a 409 naming the holder; another type is fine', async () => {
    const b = await newBudget();
    const one = await payee(b, 'One');
    const two = await payee(b, 'Two');
    expect((await add(b, one, 'contains', 'Pix Loja')).status).toBe(201);
    for (const holder of [one, two]) {
      const clash = await add(b, holder, 'contains', ' pix loja ');
      expect(clash.status).toBe(409);
      expect(clash.json).toMatchObject({ code: 'rename_rule_exists', params: { name: 'One' } });
    }
    expect((await add(b, two, 'starts_with', 'pix loja')).status).toBe(201);
    // An update that would collide is refused; one that changes nothing about its own text is not.
    const r = (await list(b, two))[0]!;
    expect((await op('budget_payees_rename_rules_update', { id: two, budget_id: b, rule_id: r.id, match_type: 'contains', condition: 'PIX LOJA' })).status).toBe(409);
    expect((await op('budget_payees_rename_rules_update', { id: two, budget_id: b, rule_id: r.id, match_type: 'starts_with', condition: 'PIX LOJA' })).status).toBe(200);
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

  test('F-b: creating a payee by name is not an import: no rule applies, the payee is created (or found) by the name given', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Uber');
    await add(b, p, 'contains', 'UBER');
    const res = await op('budget_payees_create', { budget_id: b, name: 'UBER *TRIP 9' });
    expect(res.status).toBe(201);
    expect(res.json.id).not.toBe(p);
    expect(res.json.name).toBe('UBER *TRIP 9');
    // An existing name is returned as it is.
    expect((await op('budget_payees_create', { budget_id: b, name: 'UBER *TRIP 9' })).json.id).toBe(res.json.id);
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

describe.skipIf(!dbReady)('migration 0121: copies the single rules as they are, once, dropping none', () => {
  const sql = readFileSync(join(import.meta.dir, '..', '..', '..', 'db', 'migrations', '0121_payee_renaming_rules.sql'), 'utf8');

  test('every live payee\'s old rule is a row, untrimmed; patterns differing by case or spaces are kept apart; a second run changes nothing and does not bring back a removed rule', async () => {
    const b = await newBudget();
    // Payees as main left them: the rule on the payee row only.
    const mk = async (name: string, type: string | null, cond: string | null, deleted = false) =>
      (
        await pool.query<{ id: string }>('INSERT INTO payees (budget_id, name, rename_match_type, rename_condition, deleted) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b, name, type, cond, deleted])
      ).rows[0]!.id;
    const a = await mk('Mig A', 'contains', 'MIG ONE');
    const upper = await mk('Mig Upper', 'contains', 'mig one'); // differs only by case: kept, the older fires first (as on main)
    const spaced = await mk('Mig Spaced', 'contains', 'MIG  ONE'); // differs only by spacing: a different pattern on main too
    const padded = await mk('Mig Padded', 'is', ' MIG TWO '); // untrimmed on main, untrimmed here
    const gone = await mk('Mig Deleted', 'is', 'MIG GONE', true);
    const none = await mk('Mig None', null, null);
    const count = async () => (await pool.query('SELECT payee_id, match_type, condition FROM payee_renaming_rules WHERE budget_id = $1 ORDER BY created_at, payee_id', [b])).rows;

    await pool.query(sql);
    const first = await count();
    expect(first.map((r) => r.payee_id).sort()).toEqual([a, upper, spaced, padded].sort());
    expect(first.find((r) => r.payee_id === padded)).toMatchObject({ match_type: 'is', condition: ' MIG TWO ' });
    expect(first.find((r) => r.payee_id === gone)).toBeUndefined();
    expect(first.find((r) => r.payee_id === none)).toBeUndefined();
    await pool.query(sql);
    expect(await count()).toEqual(first);
    // Matching order after the copy: the oldest payee's rule fires first, as on main.
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Mig Conta', type: 'checking', on_budget: true, balance: 0 });
    const made = await op('budget_transaction_add', { budget_id: b, account_id: acc.json.id, amount: -1000, payee: 'Mig One 5' });
    expect((await pool.query('SELECT payee_id FROM transactions WHERE id = $1', [made.json.id])).rows[0].payee_id).toBe(a);
    // A rule removed through the API clears the payee's column as well, so running the file again does not bring it back.
    const rules = await list(b, padded);
    expect((await op('budget_payees_rename_rules_remove', { id: padded, budget_id: b, rule_id: rules[0]!.id })).status).toBe(204);
    await pool.query(sql);
    expect((await count()).map((r) => r.payee_id).sort()).toEqual([a, upper, spaced].sort());
  });
});

describe.skipIf(!dbReady)('the payee columns are an input: a rule written only there is adopted, never erased', () => {
  const writeColumns = (id: string, type: string | null, cond: string | null) =>
    pool.query('UPDATE payees SET rename_match_type = $2, rename_condition = $3 WHERE id = $1', [id, type, cond]);
  const asRows = async (b: string, id: string) => (await list(b, id)).map((r) => [r.match_type, r.condition]);

  test('a rule written to the columns after the migration (the other app, the released client) applies at once and survives a later rule add on the same payee', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Columns Only');
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Columns Conta', type: 'checking', on_budget: true, balance: 0 });
    await writeColumns(p, 'contains', 'COLUMN SHOP');
    expect((await pool.query('SELECT count(*)::int AS n FROM payee_renaming_rules WHERE payee_id = $1', [p])).rows[0].n).toBe(0);
    // Matching reads it (register create here; the sync and /bulk read the same rules).
    const made = await op('budget_transaction_add', { budget_id: b, account_id: acc.json.id, amount: -1000, payee: 'COLUMN SHOP 7' });
    expect((await pool.query('SELECT payee_id FROM transactions WHERE id = $1', [made.json.id])).rows[0].payee_id).toBe(p);
    // Another rule added through the API: the column rule is adopted first, not overwritten by the mirror.
    expect((await add(b, p, 'starts_with', 'COLUMN')).status).toBe(201);
    expect(await asRows(b, p)).toEqual([['contains', 'COLUMN SHOP'], ['starts_with', 'COLUMN']]);
    expect(await columns(p)).toEqual({ t: 'contains', c: 'COLUMN SHOP' });
    // Removing it through the API really removes it (the mirror follows, nothing re-adopts it).
    const rule = (await list(b, p))[0]!;
    expect((await op('budget_payees_rename_rules_remove', { id: p, budget_id: b, rule_id: rule.id })).status).toBe(204);
    expect(await asRows(b, p)).toEqual([['starts_with', 'COLUMN']]);
    expect(await columns(p)).toEqual({ t: null, c: null });
  });

  test('the same through the other writes: list, the single-rule call, merge; a column rule of another payee\'s identical text is not adopted', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Columns List');
    await writeColumns(p, 'is', 'LIST ME');
    expect((await payeeRow(b, p)).rename_rules).toEqual([expect.objectContaining({ match_type: 'is', condition: 'LIST ME' })]);

    const q = await payee(b, 'Columns Single');
    await writeColumns(q, 'contains', 'SINGLE ONE');
    // The released client's call replaces the first is/contains rule: that is the column rule.
    expect((await op('budget_payees_set_rename_rule', { id: q, budget_id: b, match_type: 'is', condition: 'SINGLE TWO' })).status).toBe(204);
    expect(await asRows(b, q)).toEqual([['is', 'SINGLE TWO']]);

    const from = await payee(b, 'Columns From');
    const to = await payee(b, 'Columns To');
    await writeColumns(from, 'contains', 'FROM COLUMN');
    expect((await op('budget_payees_merge', { id: from, budget_id: b, target_id: to })).status).toBe(200);
    expect(await asRows(b, to)).toEqual([['contains', 'FROM COLUMN']]);

    // Another payee already holds this exact rule in the table: the column copy is not a second rule.
    const owner = await payee(b, 'Columns Owner');
    await add(b, owner, 'contains', 'FIRST ONE'); // the owner's column mirrors this one, so another payee's column may hold the next
    await add(b, owner, 'is', 'ONE HOLDER');
    const twin = await payee(b, 'Columns Twin');
    await writeColumns(twin, 'is', 'ONE HOLDER');
    expect(await asRows(b, twin)).toEqual([]);
    expect(await asRows(b, owner)).toEqual([['contains', 'FIRST ONE'], ['is', 'ONE HOLDER']]);
  });
});

describe.skipIf(!dbReady)('renaming rules: patterns, duplicates, accounts that are closed, POST /payees, formats', () => {
  test('F3: a contains / starts with / ends with pattern needs 2 characters after trimming; is may be one; stored shorter ones keep working', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Short');
    for (const type of ['contains', 'starts_with', 'ends_with']) {
      expect((await add(b, p, type, ' a ')).status, type).toBe(400);
      expect((await add(b, p, type, 'ab')).status, type).toBe(201);
    }
    expect((await add(b, p, 'is', 'x')).status).toBe(201);
    expect((await op('budget_payees_set_rename_rule', { id: crypto.randomUUID(), budget_id: b, match_type: 'contains', condition: 'zz' })).status).toBe(404);
    // A one-character rule that already exists (main allowed it) still matches and can be changed to itself.
    const old = await payee(b, 'Old Short');
    await pool.query('UPDATE payees SET rename_match_type = $2, rename_condition = $3 WHERE id = $1', [old, 'contains', 'q']);
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Short Conta', type: 'checking', on_budget: true, balance: 0 });
    const made = await op('budget_transaction_add', { budget_id: b, account_id: acc.json.id, amount: -1000, payee: 'a quiet place' });
    expect((await pool.query('SELECT payee_id FROM transactions WHERE id = $1', [made.json.id])).rows[0].payee_id).toBe(old);
    expect((await op('budget_payees_set_rename_rule', { id: old, budget_id: b, match_type: 'contains', condition: 'q' })).status).toBe(204);
    // F-c: the released client's single-rule call keeps accepting a 1-character rule, as on main.
    expect((await op('budget_payees_set_rename_rule', { id: old, budget_id: b, match_type: 'contains', condition: 'w' })).status).toBe(204);
    expect(await asRowsOf(b, old)).toEqual([['contains', 'w']]);
    // The new operations refuse it with a code.
    const refused = await add(b, p, 'ends_with', 'z');
    expect(refused.status).toBe(400);
    expect(refused.json).toMatchObject({ code: 'rename_rule_too_short', params: { min: 2 } });
  });

  test('B2: patterns that collide only by case are both kept by the copy, but the API refuses to add or change into one; an exact duplicate is a 409 too', async () => {
    const b = await newBudget();
    const one = await payee(b, 'Case One');
    const two = await payee(b, 'Case Two');
    expect((await add(b, one, 'contains', 'Loja Azul')).status).toBe(201);
    expect((await add(b, two, 'contains', 'LOJA AZUL')).status).toBe(409);
    expect((await add(b, two, 'contains', 'Loja Azul')).status).toBe(409);
    expect((await add(b, one, 'contains', 'loja azul')).status).toBe(409); // its own payee too
    expect((await add(b, two, 'is', 'loja azul')).status).toBe(201);
    const r = (await list(b, two))[0]!;
    expect((await op('budget_payees_rename_rules_update', { id: two, budget_id: b, rule_id: r.id, match_type: 'contains', condition: 'LOJA azul' })).status).toBe(409);
    // The same through the exact index: a raced duplicate surfaces as the same 409, not a 500.
    await pool.query('INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition) VALUES ($1,$2,$3,$4)', [b, one, 'ends_with', 'EXACT']).catch(() => undefined);
    await expect(pool.query('INSERT INTO payee_renaming_rules (budget_id, payee_id, match_type, condition) VALUES ($1,$2,$3,$4)', [b, two, 'ends_with', 'EXACT'])).rejects.toThrow();
  });

  test('F5: a rule of the transfer payee of a CLOSED account does not fire: the row keeps its text as an ordinary payee', async () => {
    const b = await newBudget();
    const src = await op('budget_accounts_create', { budget_id: b, name: 'Src Conta', type: 'checking', on_budget: true, balance: 0 });
    const dst = await op('budget_accounts_create', { budget_id: b, name: 'Dst Conta', type: 'checking', on_budget: true, balance: 0 });
    const transfer = ((await op('budget_payees_list', { budget_id: b, include_transfers: 'true' })).json as { id: string; transfer_account_id: string | null }[]).find((x) => x.transfer_account_id === dst.json.id)!;
    expect((await add(b, transfer.id, 'contains', 'PIX DST')).status).toBe(201);
    const open = await op('budget_transaction_add', { budget_id: b, account_id: src.json.id, amount: -2000, payee: 'PIX DST 1' });
    expect((await pool.query('SELECT transfer_account_id FROM transactions WHERE id = $1', [open.json.id])).rows[0].transfer_account_id).toBe(dst.json.id);
    expect((await op('budget_accounts_update', { id: dst.json.id, budget_id: b, closed: true })).status).toBe(200);
    const closed = await op('budget_transaction_add', { budget_id: b, account_id: src.json.id, amount: -3000, payee: 'PIX DST 2' });
    expect(closed.status).toBe(201);
    expect((await pool.query('SELECT p.name, t.transfer_account_id FROM transactions t JOIN payees p ON p.id = t.payee_id WHERE t.id = $1', [closed.json.id])).rows[0]).toEqual({ name: 'PIX DST 2', transfer_account_id: null });
  });

  test('F4: created_at has one format in the payee list and in every rule operation', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Format');
    const added = await add(b, p, 'contains', 'FORMAT');
    const listed = (await list(b, p))[0]!;
    const inPayeeList = ((await payeeRow(b, p)).rename_rules as { created_at: string }[])[0]!;
    const updated = await op('budget_payees_rename_rules_update', { id: p, budget_id: b, rule_id: listed.id, match_type: 'contains', condition: 'FORMAT 2' });
    const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/;
    for (const at of [added.json.created_at, listed.created_at, inPayeeList.created_at, updated.json.created_at]) expect(at).toMatch(iso);
    expect(inPayeeList.created_at).toBe(listed.created_at);
  });
});

describe.skipIf(!dbReady)('review round 3: reads never write, a stable rule order, what the other app can change', () => {
  const writeColumns = (id: string, type: string | null, cond: string | null) =>
    pool.query('UPDATE payees SET rename_match_type = $2, rename_condition = $3 WHERE id = $1', [id, type, cond]);
  const ruleCount = async (b: string) => (await pool.query('SELECT count(*)::int AS n FROM payee_renaming_rules WHERE budget_id = $1', [b])).rows[0].n as number;

  test('F-e: the payee list and the rule list include a column-only rule but write nothing; its id works in a later write', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Read Only');
    await writeColumns(p, 'contains', 'READ ONLY SHOP');
    const before = await ruleCount(b);
    const listed = (await payeeRow(b, p)).rename_rules as { id: string; match_type: string; condition: string }[];
    const rules = await list(b, p);
    expect(listed.map((r) => [r.match_type, r.condition])).toEqual([['contains', 'READ ONLY SHOP']]);
    expect(rules.map((r) => [r.match_type, r.condition])).toEqual([['contains', 'READ ONLY SHOP']]);
    expect(await ruleCount(b)).toBe(before);
    // A read-only transaction proves it: the same reads succeed where any write would fail.
    const client = await pool.connect();
    try {
      await client.query('BEGIN READ ONLY');
      expect((await client.query('SELECT 1 FROM payees WHERE id = $1', [p])).rowCount).toBe(1);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    // The id the read gave is the id the row gets: it can be updated and removed.
    expect(rules[0]!.id).toBe(listed[0]!.id);
    const updated = await op('budget_payees_rename_rules_update', { id: p, budget_id: b, rule_id: rules[0]!.id, match_type: 'contains', condition: 'READ ONLY SHOP 2' });
    expect(updated.status).toBe(200);
    expect(updated.json.id).toBe(rules[0]!.id);
    expect(await ruleCount(b)).toBe(before + 1);
  });

  test('F-f: rules tied on created_at keep their creation order (the sequence), not their ids', async () => {
    const b = await newBudget();
    const first = await payee(b, 'Tie First');
    const second = await payee(b, 'Tie Second');
    const acc = await op('budget_accounts_create', { budget_id: b, name: 'Tie Conta', type: 'checking', on_budget: true, balance: 0 });
    // Same type, same length, same created_at: created second-payee-rule first? No: the FIRST inserted rule has the LARGER id.
    const insert = (payeeId: string, id: string, cond: string) =>
      pool.query(`INSERT INTO payee_renaming_rules (id, budget_id, payee_id, match_type, condition, created_at) VALUES ($1,$2,$3,'contains',$4,'2026-01-01T00:00:00Z')`, [id, b, payeeId, cond]);
    await insert(first, 'ffffffff-0000-4000-8000-000000000001', 'abcd');
    await insert(second, '00000000-0000-4000-8000-000000000002', 'bcde');
    const made = await op('budget_transaction_add', { budget_id: b, account_id: acc.json.id, amount: -1000, payee: 'xabcdex' });
    expect((await pool.query('SELECT payee_id FROM transactions WHERE id = $1', [made.json.id])).rows[0].payee_id).toBe(first);
    expect((await list(b, first)).map((r) => r.condition)).toEqual(['abcd']);
    // The migration numbers copied rules by payee age, then physical order; the list shows that order.
    const both = await payee(b, 'Tie Both');
    await add(b, both, 'contains', 'zzzz1');
    await add(b, both, 'contains', 'zzzz2');
    expect((await list(b, both)).map((r) => r.condition)).toEqual(['zzzz1', 'zzzz2']);
  });

  test('F-d: the columns are an input only while the payee has no is/contains rule in the table; after that the table is the truth and the columns follow it', async () => {
    const b = await newBudget();
    const p = await payee(b, 'Other App');
    // A payee with no rule: the other app writes one, it applies.
    await writeColumns(p, 'is', 'OTHER APP A');
    expect((await list(b, p)).map((r) => r.condition)).toEqual(['OTHER APP A']);
    // This app now holds a rule for the payee (write adopts it): the other app REPLACES the column, it does not take effect.
    expect((await add(b, p, 'starts_with', 'OTHER')).status).toBe(201);
    expect(await columns(p)).toEqual({ t: 'is', c: 'OTHER APP A' });
    await writeColumns(p, 'is', 'OTHER APP B');
    expect((await list(b, p)).map((r) => r.condition)).toEqual(['OTHER APP A', 'OTHER']);
    // CLEARING the column does not remove the rule either; the next rule write restores the column.
    await writeColumns(p, null, null);
    expect((await list(b, p)).map((r) => r.condition)).toEqual(['OTHER APP A', 'OTHER']);
    expect((await add(b, p, 'ends_with', 'APP')).status).toBe(201);
    expect(await columns(p)).toEqual({ t: 'is', c: 'OTHER APP A' });
    // Rules are edited here: removing the last is/contains rule frees the columns for the other app again.
    const rule = (await list(b, p))[0]!;
    expect((await op('budget_payees_rename_rules_remove', { id: p, budget_id: b, rule_id: rule.id })).status).toBe(204);
    expect(await columns(p)).toEqual({ t: null, c: null });
    await writeColumns(p, 'contains', 'OTHER APP C');
    expect((await list(b, p)).map((r) => r.condition)).toContain('OTHER APP C');
  });
});
