import { describe, expect, test } from 'bun:test';

import { evidenceOf, planTransfers, readView, type MatchRow, type TransferRule } from './transfer-matcher';

let n = 0;
const TODAY = '2026-11-23';
const row = (over: Partial<MatchRow>): MatchRow => ({
  id: `t${String(++n).padStart(3, '0')}`,
  budgetId: 'b1',
  accountId: 'itau',
  accountKind: 'cash',
  onBudget: true,
  amount: -3_000_000,
  date: '2026-11-03',
  bankTime: null,
  createdAt: '2026-11-03T12:00:00.000Z',
  categoryId: null,
  splitCount: 0,
  transferAccountId: null,
  transferTransactionId: null,
  untouched: true,
  payeeId: null,
  hint: null,
  mark: null,
  ...over,
});
const out = (over: Partial<MatchRow> = {}) => row(over);
const inn = (over: Partial<MatchRow> = {}) => row({ accountId: 'nubank', amount: 3_000_000, ...over });
const card = (over: Partial<MatchRow> = {}) => row({ accountId: 'nucard', accountKind: 'card', amount: 3_000_000, ...over });
const SAME_PERSON = { category: 'Same person transfer', operationType: 'PIX' };
const PIX = { category: 'Transfer - PIX', operationType: 'PIX' };
const SHOP = { category: 'Shopping', operationType: 'PIX' };
const noRules = new Map<string, TransferRule>();
const plan = (rows: MatchRow[], rules = noRules, today = TODAY) => planTransfers(rows, rules, today);
const pairsOf = (rows: MatchRow[], rules = noRules) => plan(rows, rules).links.map((l) => [l.outflowId, l.inflowId]);

describe('evidenceOf', () => {
  test('classifies Pluggy categories and operation types', () => {
    expect(evidenceOf(SAME_PERSON)).toBe('strong');
    expect(evidenceOf({ category: 'Credit card payment', operationType: null })).toBe('strong');
    expect(evidenceOf({ category: null, operationType: 'PAGAMENTO_FATURA' })).toBe('strong');
    expect(evidenceOf(PIX)).toBe('weak');
    expect(evidenceOf({ category: 'Transfers', operationType: null })).toBe('weak');
    expect(evidenceOf({ category: null, operationType: 'TED' })).toBe('weak');
    expect(evidenceOf(SHOP)).toBe('against');
    expect(evidenceOf({ category: null, operationType: 'OUTROS' })).toBe('none');
    expect(evidenceOf(null)).toBe('none');
  });
});

describe('planTransfers: account kinds', () => {
  test('cash to cash, unique, same day: auto-linked', () => {
    const a = out();
    const b = inn();
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
  });
  test('cash to card (card payment): auto-linked, up to 3 days apart either way', () => {
    const a = out({ date: '2026-11-03' });
    const b = card({ date: '2026-11-06' });
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
    expect(pairsOf([out(), card({ date: '2026-11-07' })])).toEqual([]);
  });
  test('card to card: auto-linked', () => {
    const a = row({ accountId: 'card1', accountKind: 'card' });
    const b = card();
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
  });
  test('card outflow into a cash account is never paired (refund / cash advance)', () => {
    const p = plan([row({ accountId: 'card1', accountKind: 'card' }), inn()]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([]);
  });
  test('other account kinds, off-budget accounts and other budgets never pair', () => {
    expect(plan([out({ accountKind: 'other' }), inn()]).links).toEqual([]);
    expect(plan([out({ onBudget: false }), inn()]).links).toEqual([]);
    const p = plan([out(), inn({ budgetId: 'b2' })]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([]);
  });
  test('amounts must be exactly equal; same account never pairs', () => {
    expect(pairsOf([out(), inn({ amount: 3_000_010 })])).toEqual([]);
    expect(pairsOf([out(), inn({ accountId: 'itau' })])).toEqual([]);
  });
  test('categorized, split and already linked rows are left alone', () => {
    expect(plan([out({ categoryId: 'c' }), inn()]).links).toEqual([]);
    expect(plan([out({ splitCount: 2 }), inn()]).links).toEqual([]);
    expect(plan([out({ transferTransactionId: 'x' }), inn()]).links).toEqual([]);
  });
});

describe('planTransfers: ordinal pairing of repeats', () => {
  test('k outflows and k inflows of one account pair pair in date order', () => {
    const o1 = out({ amount: -100_000, date: '2026-10-20', hint: PIX });
    const o2 = out({ amount: -100_000, date: '2026-10-20', hint: PIX });
    const o3 = out({ amount: -100_000, date: '2026-10-21', hint: PIX });
    const i1 = inn({ amount: 100_000, date: '2026-10-20', hint: PIX });
    const i2 = inn({ amount: 100_000, date: '2026-10-21', hint: PIX });
    const i3 = inn({ amount: 100_000, date: '2026-10-21', hint: PIX });
    const p = plan([o3, i2, o1, i3, o2, i1]);
    expect(p.links.map((l) => [l.outflowId, l.inflowId, l.basis])).toEqual([
      [o1.id, i1.id, 'ordinal'],
      [o2.id, i2.id, 'ordinal'],
      [o3.id, i3.id, 'ordinal'],
    ]);
    expect(p.suggestions).toEqual([]);
  });
  test('same-day repeats order by the bank time', () => {
    const o1 = out({ amount: -100_000, bankTime: '2026-10-20T15:00:00Z', hint: PIX });
    const o2 = out({ amount: -100_000, bankTime: '2026-10-20T09:00:00Z', hint: PIX });
    const i1 = inn({ amount: 100_000, bankTime: '2026-10-20T09:00:05Z', hint: PIX });
    const i2 = inn({ amount: 100_000, bankTime: '2026-10-20T15:00:03Z', hint: PIX });
    const links = plan([o1, o2, i1, i2]).links.map((l) => [l.outflowId, l.inflowId]);
    expect(links).toContainEqual([o2.id, i1.id]);
    expect(links).toContainEqual([o1.id, i2.id]);
  });
  test('ordinal pairs without bank evidence are suggestions, not auto-links', () => {
    const rows = [out({ amount: -100_000 }), out({ amount: -100_000 }), inn({ amount: 100_000 }), inn({ amount: 100_000 })];
    const p = plan(rows);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((s) => [s.confidence, s.basis])).toEqual([
      ['sure', 'ordinal'],
      ['sure', 'ordinal'],
    ]);
  });
  test('k != m: the single alignment that fits the window pairs; the rest stays a suggestion', () => {
    // Two outflows (20th, 25th), one inflow (24th): only the 25th fits.
    const o1 = out({ amount: -100_000, date: '2026-10-20', hint: PIX });
    const o2 = out({ amount: -100_000, date: '2026-10-25', hint: PIX });
    const i1 = inn({ amount: 100_000, date: '2026-10-24', hint: PIX });
    expect(pairsOf([o1, o2, i1])).toEqual([[o2.id, i1.id]]);
    // Two outflows the same day and one inflow: ambiguous, a "choose" suggestion.
    const a = out({ amount: -200_000, date: '2026-10-20' });
    const b = out({ amount: -200_000, date: '2026-10-20' });
    const c = inn({ amount: 200_000, date: '2026-10-20' });
    const p = plan([a, b, c]);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((s) => [s.id, s.confidence, s.candidateIds])).toEqual([
      [a.id, 'choose', [c.id]],
      [b.id, 'choose', [c.id]],
    ]);
    expect(p.rows.get(c.id)).toEqual({ confidence: 'choose', candidateCount: 2, counterpartId: null });
  });
  test('one outflow, two possible accounts: choose between them', () => {
    const a = out({ amount: -100_000 });
    const b = inn({ amount: 100_000 });
    const c = card({ amount: 100_000 });
    const p = plan([a, b, c]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([{ id: a.id, confidence: 'choose', basis: 'ambiguous', candidateIds: [b.id, c.id].sort() }]);
    expect(p.rows.get(a.id)).toEqual({ confidence: 'choose', candidateCount: 2, counterpartId: null });
  });
});

describe('planTransfers: evidence', () => {
  test('evidence breaks a tie; strong on both sides auto-links, weak stays a suggestion', () => {
    const a = out({ hint: SAME_PERSON });
    const b = inn({ hint: SAME_PERSON });
    const c = card({ hint: SHOP });
    const p = plan([a, b, c]);
    expect(p.links).toEqual([{ outflowId: a.id, inflowId: b.id, method: 'auto', basis: 'evidence' }]);
    const d = out({ hint: PIX });
    const e = inn({ hint: PIX });
    const f = card();
    const q = plan([d, e, f]);
    expect(q.links).toEqual([]);
    expect(q.suggestions).toEqual([{ id: d.id, confidence: 'sure', basis: 'evidence', candidateIds: [e.id] }]);
  });
  test('a contradicting bank category vetoes auto-link for cash to cash (suggestion), not for card payments', () => {
    const a = out({ hint: SHOP });
    const b = inn();
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions[0]).toMatchObject({ id: a.id, confidence: 'sure', basis: 'unique' });
    expect(pairsOf([out({ hint: SHOP }), card()])).toHaveLength(1);
  });
  test('a lone row Pluggy calls a same-person transfer is a one-side suggestion; weak evidence alone is not', () => {
    const a = out({ hint: SAME_PERSON, amount: -800_000 });
    expect(plan([a]).suggestions).toEqual([{ id: a.id, confidence: 'one_side', basis: 'unmatched', candidateIds: [] }]);
    expect(plan([out({ hint: PIX })]).suggestions).toEqual([]);
  });
});

describe('planTransfers: edits and decisions', () => {
  test('edited rows pair as a suggestion only', () => {
    const a = out({ untouched: false });
    const b = inn();
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([{ id: a.id, confidence: 'sure', basis: 'unique', candidateIds: [b.id] }]);
    expect(p.rows.get(b.id)).toEqual({ confidence: 'sure', candidateCount: 1, counterpartId: a.id });
  });
  test('a dismissed row is never suggested or linked, and is no candidate either', () => {
    const a = out({ mark: 'dismissed', hint: SAME_PERSON });
    const b = inn();
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([]);
  });
  test('a row whose link was undone ("manual") stays a suggestion, never auto-linked', () => {
    const p = plan([out({ mark: 'manual' }), inn()]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toHaveLength(1);
  });
  test('a row marked outside the budget is pending "outside" and not matched', () => {
    const a = out({ mark: 'outside' });
    const p = plan([a, inn()]);
    expect(p.pending.get(a.id)).toBe('outside');
    expect(p.links).toEqual([]);
  });
  test('a "never" payee rule suppresses suggestions and links', () => {
    const rules = new Map<string, TransferRule>([['p1', { mode: 'never', accountId: null, noMatch: 'review', waitDays: 5, since: null }]]);
    const p = plan([out({ payeeId: 'p1', hint: SAME_PERSON }), inn()], rules);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([]);
  });
});

describe('planTransfers: payee rules', () => {
  const auto = (over: Partial<TransferRule> = {}): Map<string, TransferRule> =>
    new Map([['pix', { mode: 'auto', accountId: null, noMatch: 'outside', waitDays: 5, since: null, ...over }]]);

  test('a rule links its row even when edited and ambiguous (closest date first)', () => {
    const a = out({ payeeId: 'pix', untouched: false, date: '2026-11-03' });
    const b = inn({ date: '2026-11-05' });
    const c = card({ date: '2026-11-03' });
    const p = plan([a, b, c], auto());
    expect(p.links).toEqual([{ outflowId: a.id, inflowId: c.id, method: 'rule', basis: 'rule' }]);
  });
  test('a fixed-account rule only pairs with that account', () => {
    const a = out({ payeeId: 'pix' });
    const b = inn();
    const c = card();
    const p = plan([a, b, c], auto({ mode: 'account', accountId: 'nubank' }));
    expect(p.links).toEqual([{ outflowId: a.id, inflowId: b.id, method: 'rule', basis: 'unique' }]);
  });
  test('no other side yet: waiting within the window, then outside or review per the rule', () => {
    const fresh = out({ payeeId: 'pix', date: '2026-11-20' });
    expect(plan([fresh], auto()).pending.get(fresh.id)).toBe('waiting');
    const old = out({ payeeId: 'pix', date: '2026-11-01' });
    expect(plan([old], auto()).pending.get(old.id)).toBe('outside');
    const p = plan([old], auto({ noMatch: 'review' }));
    expect(p.pending.has(old.id)).toBe(false);
    expect(p.suggestions).toEqual([{ id: old.id, confidence: 'one_side', basis: 'unmatched', candidateIds: [] }]);
  });
  test('the waiting row links once its other side arrives', () => {
    const a = out({ payeeId: 'pix', date: '2026-11-20' });
    expect(plan([a], auto()).links).toEqual([]);
    const b = inn({ date: '2026-11-21', untouched: false });
    expect(plan([a, b], auto()).links).toEqual([{ outflowId: a.id, inflowId: b.id, method: 'rule', basis: 'unique' }]);
  });
  test('a rule set after a row was created does not cover it', () => {
    const a = out({ payeeId: 'pix', untouched: false, createdAt: '2026-11-01T00:00:00.000Z' });
    const p = plan([a, inn()], auto({ since: '2026-11-10T00:00:00.000Z' }));
    expect(p.links).toEqual([]);
    expect(p.suggestions).toHaveLength(1);
  });
});

describe('readView', () => {
  test('links the next sync would make show as sure suggestions on both rows', () => {
    const a = out();
    const b = inn();
    const view = readView(plan([a, b]));
    expect(view.links).toEqual([]);
    expect(view.suggestions).toEqual([{ id: a.id, confidence: 'sure', basis: 'unique', candidateIds: [b.id] }]);
    expect(view.rows.get(a.id)?.counterpartId).toBe(b.id);
    expect(view.rows.get(b.id)?.counterpartId).toBe(a.id);
  });
  test('a full-history bucket of repeats stays fast (bucketed by amount)', () => {
    const rows: MatchRow[] = [];
    for (let d = 0; d < 2000; d++) {
      const date = new Date(Date.UTC(2020, 0, 1) + d * 86_400_000).toISOString().slice(0, 10);
      rows.push(out({ amount: -100_000, date, hint: PIX }), inn({ amount: 100_000, date, hint: PIX }));
      rows.push(out({ amount: -(d + 1) * 1000 - 7, date }));
    }
    const started = performance.now();
    const p = plan(rows);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(p.links.length).toBe(2000);
  });
});
