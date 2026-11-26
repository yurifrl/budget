import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { conversionMessage, runConversion, sameRuleSet, type ConvertApi, type FailureInfo, type RuleBody, type RuleRef } from './convertRun.logic';
import type { ConversionPlan } from './renameRules.logic';

afterEach(() => setLocale('en'));

const TNAME = 'Transfer : Savings';
const PAYEE = 'p1';
const TARGET = 't1';
const ref = (id: string, match_type: RuleRef['match_type'], condition: string): RuleRef => ({ id, match_type, condition });
type Plan = ConversionPlan['rules'];
const entry = (key: string, matchType: RuleRef['match_type'], text: string, moveFrom: string | null): Plan[number] => ({ key, matchType, text, moveFrom });

/** An in-memory server with the budget-wide duplicate check and scripted failures. */
function fake(init: { payee: RuleRef[]; target?: RuleRef[]; other?: RuleRef[]; fail?: (call: string) => 'network' | '500' | 'conflict' | null; offSavedThenThrows?: boolean }) {
  const rules: Record<string, RuleRef[]> = { [PAYEE]: [...init.payee], [TARGET]: [...(init.target ?? [])], q: [...(init.other ?? [])] };
  const holder = (type: string, text: string) => Object.entries(rules).find(([, l]) => l.some((r) => r.match_type === type && r.condition.toLowerCase() === text.toLowerCase()));
  const log: string[] = [];
  let seq = 0;
  let off = false;
  const names: Record<string, string> = { [PAYEE]: 'Uber', [TARGET]: 'Transfer : Savings', q: 'Other payee' };
  const api: ConvertApi = {
    readRules: async (id) => {
      log.push(`read ${id}`);
      if (init.fail?.(`read ${id}`)) throw { status: 500 };
      return [...rules[id]!];
    },
    addRule: async (id, body: RuleBody) => {
      const call = `add ${id} ${body.match_type}:${body.condition}`;
      log.push(call);
      const f = init.fail?.(call);
      if (f === 'network') throw { status: 'FETCH_ERROR' };
      if (f === '500') throw { status: 500 };
      const h = holder(body.match_type, body.condition);
      if (f === 'conflict' || h) throw { status: 409, code: 'rename_rule_exists', holder: names[h?.[0] ?? 'q'] };
      const r = ref(`n${++seq}`, body.match_type, body.condition);
      rules[id]!.push(r);
      return r;
    },
    removeRule: async (id, ruleId) => {
      log.push(`remove ${id} ${ruleId}`);
      if (init.fail?.(`remove ${id} ${ruleId}`)) throw { status: 500 };
      const i = rules[id]!.findIndex((r) => r.id === ruleId);
      if (i < 0) throw { status: 404 };
      rules[id]!.splice(i, 1);
    },
    turnOff: async () => {
      log.push('off');
      if (init.offSavedThenThrows) {
        off = true;
        throw { status: 'FETCH_ERROR' };
      }
      if (init.fail?.('off')) throw { status: 500 };
      off = true;
    },
    classify: (err): FailureInfo => err as FailureInfo,
  };
  return { api, rules, log, isOff: () => off };
}

const run = (f: ReturnType<typeof fake>, plan: Plan, shown?: RuleRef[]) =>
  runConversion({ payeeId: PAYEE, targetId: TARGET, shown: shown ?? f.rules[PAYEE]!, plan, api: f.api });
const texts = (rs: RuleRef[]) => rs.map((r) => `${r.match_type}:${r.condition}`).sort();

describe('runConversion', () => {
  const own = [ref('r1', 'contains', 'UBER TRIP')];
  const plan: Plan = [entry('name', 'is', 'Uber', null), entry('rule:r1', 'contains', 'UBER TRIP', 'r1')];

  test('a normal conversion: creates "is", moves the rule, switches the old setting off last', async () => {
    const f = fake({ payee: own });
    expect(await run(f, plan)).toEqual({ ok: true });
    expect(texts(f.rules[TARGET]!)).toEqual(['contains:UBER TRIP', 'is:Uber']);
    expect(f.rules[PAYEE]).toEqual([]);
    expect(f.isOff()).toBe(true);
    expect(f.log.at(-1)).toBe('off');
  });

  test('stale: the payee\'s rules are not what the notice showed, so nothing is written', async () => {
    const f = fake({ payee: own });
    const res = await run(f, plan, [ref('r1', 'contains', 'UBER TRIP'), ref('r9', 'ends_with', 'X')]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'stale' }, unrestored: [] });
    expect(f.log.filter((l) => /^(add|remove|off)/.test(l))).toEqual([]);
    expect(f.isOff()).toBe(false);
  });

  test('a rule edited in the card (same id, new text) is stale too', async () => {
    const f = fake({ payee: [ref('r1', 'contains', 'UBER TRIP SP')] });
    expect((await run(f, plan, own)).ok).toBe(false);
    expect(f.rules[PAYEE]).toHaveLength(1);
  });

  // The person edited the moved rule's text in the notice to one that payee "Other payee" holds.
  const editedPlan: Plan = [entry('name', 'is', 'Uber', null), entry('rule:r1', 'contains', 'UBER TRIP SP', 'r1')];
  const holderQ = [ref('q1', 'contains', 'uber trip sp')];

  test('X1: another payee holds the moved rule: stops, puts it back, names rule and holder, old setting on', async () => {
    const f = fake({ payee: own, other: holderQ });
    const res = await run(f, editedPlan);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.failure).toEqual({ kind: 'held', rule: 'Contains “UBER TRIP SP”', holder: 'Other payee' });
    expect(res.unrestored).toEqual([]);
    expect(texts(f.rules[PAYEE]!)).toEqual(['contains:UBER TRIP']); // back on the payee, original text
    expect(f.rules[TARGET]).toEqual([]); // the "is Uber" rule this run created is removed again: exactly as before
    expect(f.isOff()).toBe(false);
    const msg = conversionMessage(res, () => 'x', TNAME);
    expect(msg).toContain('Contains “UBER TRIP SP”');
    expect(msg).toContain('“Other payee”');
    expect(msg).toContain('old setting is still on');
  });

  test('X1: a retry after that put-back stops the same way (never "moved" without moving)', async () => {
    const f = fake({ payee: own, other: holderQ });
    await run(f, editedPlan);
    const retryPlan: Plan = [editedPlan[0]!, entry('rule:' + f.rules[PAYEE]![0]!.id, 'contains', 'UBER TRIP SP', f.rules[PAYEE]![0]!.id)];
    const again = await run(f, retryPlan, f.rules[PAYEE]!);
    expect(again).toMatchObject({ ok: false, failure: { kind: 'held' }, unrestored: [] });
    expect(texts(f.rules[PAYEE]!)).toEqual(['contains:UBER TRIP']);
    expect(f.isOff()).toBe(false);
  });

  test('X1: a typed (new) rule that another payee holds is not counted as created', async () => {
    const f = fake({ payee: [], other: [ref('q1', 'is', 'uber')] });
    const res = await run(f, [entry('name', 'is', 'Uber', null)]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'held', holder: 'Other payee' } });
    expect(f.isOff()).toBe(false);
  });

  test('a 409 when the TARGET already holds the rule is done (an earlier attempt)', async () => {
    const f = fake({ payee: [], target: [ref('t9', 'is', 'Uber')] });
    expect(await run(f, [entry('name', 'is', 'Uber', null)])).toEqual({ ok: true });
    expect(f.isOff()).toBe(true);
  });

  test('a 409 after the remove, with the target holding it meanwhile, counts as moved', async () => {
    const f = fake({ payee: own });
    let reads = 0;
    const read = f.api.readRules;
    f.api.readRules = async (id) => {
      if (id === TARGET && ++reads === 2) f.rules[TARGET]!.push(ref('t5', 'contains', 'UBER TRIP')); // appears between check and add
      return read(id);
    };
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1')]);
    expect(res).toEqual({ ok: true });
    expect(f.rules[PAYEE]).toEqual([]);
  });

  test('failure points of a move: remove fails -> nothing removed, nothing added, old setting on', async () => {
    const f = fake({ payee: own, fail: (c) => (c.startsWith('remove p1') ? '500' : null) });
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1')]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'error' }, unrestored: [] });
    expect(texts(f.rules[PAYEE]!)).toEqual(['contains:UBER TRIP']);
    expect(f.rules[TARGET]).toEqual([]);
    expect(f.isOff()).toBe(false);
  });

  test('failure points of a move: the add fails -> put back, then a retry succeeds', async () => {
    let broken = true;
    const f = fake({ payee: own, fail: (c) => (broken && c.startsWith('add t1') ? 'network' : null) });
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1')]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'error' }, unrestored: [] });
    expect(texts(f.rules[PAYEE]!)).toEqual(['contains:UBER TRIP']);
    expect(f.isOff()).toBe(false);
    broken = false;
    expect(await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', f.rules[PAYEE]![0]!.id)], f.rules[PAYEE]!)).toEqual({ ok: true });
    expect(f.rules[PAYEE]).toEqual([]);
    expect(texts(f.rules[TARGET]!)).toEqual(['contains:UBER TRIP']);
    expect(f.isOff()).toBe(true);
  });

  test('failure points of a move: add and put-back both fail -> the rule is named, never swallowed', async () => {
    const f = fake({ payee: own, fail: (c) => (c.startsWith('add ') ? '500' : null) });
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1')]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'error' }, unrestored: ['Contains “UBER TRIP”'] });
    if (res.ok) return;
    const msg = conversionMessage(res, () => 'boom', TNAME);
    expect(msg).toContain('boom');
    expect(msg).toContain('Contains “UBER TRIP”');
    expect(msg).not.toContain('as they were');
    expect(f.isOff()).toBe(false);
  });

  test('a later rule fails: the moves of this run are undone, the old setting stays on', async () => {
    const two = [ref('r1', 'contains', 'UBER TRIP'), ref('r2', 'ends_with', 'LTDA')];
    const f = fake({ payee: two, other: [ref('q1', 'ends_with', 'ltda sa')] });
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1'), entry('rule:r2', 'ends_with', 'LTDA SA', 'r2')]);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'held' }, unrestored: [] });
    expect(texts(f.rules[PAYEE]!)).toEqual(['contains:UBER TRIP', 'ends_with:LTDA']);
    expect(f.rules[TARGET]).toEqual([]);
    expect(f.isOff()).toBe(false);
  });

  test('only "off" fails: the saved rules stay, the message says so, a retry only switches off', async () => {
    let broken = true;
    const f = fake({ payee: own, fail: (c) => (broken && c === 'off' ? '500' : null) });
    const res = await run(f, plan);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'offFailed' }, unrestored: [], onTarget: [] });
    if (res.ok) return;
    expect(texts(f.rules[TARGET]!)).toEqual(['contains:UBER TRIP', 'is:Uber']);
    expect(f.rules[PAYEE]).toEqual([]);
    expect(f.isOff()).toBe(false);
    expect(conversionMessage(res, () => 'boom', TNAME)).toContain('saved on “Transfer : Savings”');
    broken = false;
    f.log.length = 0;
    // The notice now lists only what the payee still has (the "is" entry); the plan finds it on the target.
    expect(await run(f, [entry('name', 'is', 'Uber', null)], f.rules[PAYEE]!)).toEqual({ ok: true });
    expect(f.log.filter((l) => l.startsWith('add') || l.startsWith('remove'))).toEqual([]);
    expect(f.isOff()).toBe(true);
  });

  test('"off" was saved but its answer was lost: a retry ends finished, nothing moved back', async () => {
    const f = fake({ payee: own, offSavedThenThrows: true });
    const res = await run(f, plan);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'offFailed' } });
    expect(f.isOff()).toBe(true);
    expect(f.rules[PAYEE]).toEqual([]); // not put back while the setting is off
    expect(texts(f.rules[TARGET]!)).toEqual(['contains:UBER TRIP', 'is:Uber']);
  });

  test('a rule the target held before the run is never removed by an abort', async () => {
    const f = fake({ payee: own, target: [ref('t9', 'is', 'Uber')], other: holderQ });
    await run(f, editedPlan);
    expect(f.rules[TARGET]!.map((r) => r.id)).toEqual(['t9']);
  });

  test('B1: a created rule that cannot be removed is named as being on the target, not "add by hand"', async () => {
    const f = fake({ payee: own, other: holderQ, fail: (c) => (c.startsWith('remove t1') ? '500' : null) });
    const res = await run(f, editedPlan);
    expect(res).toMatchObject({ ok: false, failure: { kind: 'held' }, unrestored: [], onTarget: ['Is “Uber”'] });
    if (res.ok) return;
    const msg = conversionMessage(res, () => 'x', TNAME);
    expect(msg).toContain('Is “Uber”');
    expect(msg).toContain('now on “Transfer : Savings”');
    expect(msg).not.toContain('by hand');
    expect(msg).not.toContain('Everything is as it was');
  });

  test('a moved rule that cannot be removed from the target on undo is named as on the target', async () => {
    const two = [ref('r1', 'contains', 'UBER TRIP'), ref('r2', 'ends_with', 'LTDA')];
    const f = fake({ payee: two, other: [ref('q1', 'ends_with', 'ltda sa')], fail: (c) => (c.startsWith('remove t1') ? '500' : null) });
    const res = await run(f, [entry('k1', 'contains', 'UBER TRIP', 'r1'), entry('k2', 'ends_with', 'LTDA SA', 'r2')]);
    expect(res).toMatchObject({ ok: false, unrestored: [], onTarget: ['Contains “UBER TRIP”'] });
  });

  test('undo of a move whose put-back cannot land is named', async () => {
    const two = [ref('r1', 'contains', 'UBER TRIP'), ref('r2', 'ends_with', 'LTDA')];
    const f = fake({ payee: two, other: [ref('q1', 'ends_with', 'ltda sa')], fail: (c) => (c === 'add p1 contains:UBER TRIP' ? '500' : null) });
    const res = await run(f, [entry('rule:r1', 'contains', 'UBER TRIP', 'r1'), entry('rule:r2', 'ends_with', 'LTDA SA', 'r2')]);
    expect(res).toMatchObject({ ok: false, unrestored: ['Contains “UBER TRIP”'], onTarget: [] }); // r1 could not go back; r2 (edited) did
  });

  test('reading the payee\'s rules fails: nothing is written', async () => {
    const f = fake({ payee: own, fail: (c) => (c === 'read p1' ? '500' : null) });
    expect(await run(f, plan)).toMatchObject({ ok: false, failure: { kind: 'error' } });
    expect(f.log.filter((l) => /^(add|remove|off)/.test(l))).toEqual([]);
  });
});

describe('sameRuleSet / messages', () => {
  test('order and letter case do not matter; ids and texts do', () => {
    expect(sameRuleSet([ref('a', 'is', 'X'), ref('b', 'ends_with', 'y')], [ref('b', 'ends_with', 'Y'), ref('a', 'is', 'x')])).toBe(true);
    expect(sameRuleSet([ref('a', 'is', 'X')], [ref('c', 'is', 'X')])).toBe(false);
    expect(sameRuleSet([ref('a', 'is', 'X')], [])).toBe(false);
  });

  test('the held message in pt-BR, with and without the holder', () => {
    setLocale('pt-BR');
    expect(conversionMessage({ ok: false, failure: { kind: 'held', rule: 'Contém “X”', holder: 'Ana' }, unrestored: [], onTarget: [] }, () => '', TNAME)).toContain('“Ana”');
    expect(conversionMessage({ ok: false, failure: { kind: 'held', rule: 'Contém “X”', holder: null }, unrestored: [], onTarget: [] }, () => '', TNAME)).toContain('outro favorecido');
  });
});
