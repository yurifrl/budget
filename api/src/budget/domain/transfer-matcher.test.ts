import { describe, expect, test } from 'bun:test';

import { evidenceOf, matcherMark, pairViolation, planTransfers, readView, sameBank, type MatchRow, type TransferRule } from './transfer-matcher';

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
  bank: null,
  connectionId: null,
  checking: true,
  hintAccountId: null,
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
  test('card to card is never linked: a card only receives; it is offered as a refused suggestion (budget-zkts)', () => {
    const a = row({ accountId: 'card1', accountKind: 'card', hint: SAME_PERSON });
    const b = card({ hint: SAME_PERSON });
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      { id: a.id, confidence: 'sure', basis: 'refused', candidateIds: [b.id], violations: { [b.id]: 'card_outflow' } },
    ]);
  });
  test('card outflow against a cash inflow is no pair at all, as before (refund / cash advance): no link, no suggestion', () => {
    const a = row({ accountId: 'card1', accountKind: 'card', date: '2026-11-03' });
    const b = inn({ date: '2026-11-06' });
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([]);
    expect(p.rows.size).toBe(0);
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
  test('an old "outside the budget" mark is not a state: the row is never pending, and is suggested like an undone link', () => {
    // budget-dt00: the stored value stays in transfer_marks, the matcher reads it
    // as `manual` (the person once answered about the row, so it is offered but
    // never linked on its own: nothing moves without them).
    expect(matcherMark('outside')).toBe('manual');
    expect(matcherMark('dismissed')).toBe('dismissed');
    expect(matcherMark('manual')).toBe('manual');
    expect(matcherMark(null)).toBeNull();
    const a = out({ mark: matcherMark('outside') });
    const p = plan([a, inn()]);
    expect(p.pending.size).toBe(0);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((s) => [s.id, s.confidence])).toEqual([[a.id, 'sure']]);
    // Alone, it is an ordinary row: nothing pending, nothing suggested.
    const lone = out({ mark: matcherMark('outside'), amount: -1234 });
    const q = plan([lone]);
    expect(q.pending.size).toBe(0);
    expect(q.suggestions).toEqual([]);
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
  test('no other side yet: waiting within the window, then an ordinary row or review per the rule', () => {
    const fresh = out({ payeeId: 'pix', date: '2026-11-20' });
    expect(plan([fresh], auto()).pending.get(fresh.id)).toBe('waiting');
    const old = out({ payeeId: 'pix', date: '2026-11-01' });
    // The stored policy `outside` no longer keeps the row as a transfer outside
    // the budget (budget-dt00): past the wait it is just a transaction (no
    // pending state, no suggestion), so it needs a category like any other.
    const expired = plan([old], auto());
    expect(expired.pending.size).toBe(0);
    expect(expired.suggestions).toEqual([]);
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

describe('planTransfers: account rules (budget-zkts)', () => {
  // Accounts: Itaú conta / Itaú cartão / Nubank conta / Nubank cartão, banks known.
  const itauConta = { accountId: 'itau', accountKind: 'cash' as const, bank: 'itau' };
  const itauCard = { accountId: 'itaucard', accountKind: 'card' as const, bank: 'itau' };
  const nuConta = { accountId: 'nubank', accountKind: 'cash' as const, bank: 'nubank' };
  const nuCard = { accountId: 'nucard', accountKind: 'card' as const, bank: 'nubank' };
  const o = (acc: Partial<MatchRow>, over: Partial<MatchRow> = {}) => row({ ...acc, amount: -100_000, ...over });
  const i = (acc: Partial<MatchRow>, over: Partial<MatchRow> = {}) => row({ ...acc, amount: 100_000, ...over });

  test('pairViolation / sameBank: each rule, unknown banks pass', () => {
    const side = (accountKind: 'cash' | 'card', bank: string | null, connectionId: string | null = null, checking = accountKind === 'cash') => ({
      accountKind,
      bank,
      connectionId,
      checking,
    });
    expect(pairViolation(side('card', 'itau'), side('card', 'itau'))).toBe('card_outflow');
    expect(pairViolation(side('card', null), side('cash', null))).toBe('card_outflow');
    expect(pairViolation(side('cash', 'itau'), side('card', 'itau'))).toBeNull();
    expect(pairViolation(side('cash', 'itau'), side('card', 'nubank'))).toBe('card_payment_other_bank');
    expect(pairViolation(side('cash', 'itau'), side('cash', 'nubank'))).toBeNull();
    expect(pairViolation(side('cash', 'nubank'), side('cash', 'nubank'))).toBe('cash_same_bank');
    expect(pairViolation(side('cash', 'itau'), side('card', null))).toBeNull();
    expect(pairViolation(side('cash', null), side('cash', null))).toBeNull();
    // No institution label: the same connection means the same bank; different connections are unknown.
    expect(sameBank({ bank: null, connectionId: 'c1' }, { bank: null, connectionId: 'c1' })).toBe(true);
    expect(sameBank({ bank: null, connectionId: 'c1' }, { bank: null, connectionId: 'c2' })).toBeNull();
    expect(sameBank({ bank: 'itau', connectionId: 'c1' }, { bank: 'nubank', connectionId: 'c1' })).toBe(false);
    expect(pairViolation(side('cash', null, 'c1'), side('card', null, 'c1'))).toBeNull();
    expect(pairViolation(side('cash', null, 'c1'), side('cash', null, 'c1'))).toBe('cash_same_bank');
    // Rule 3 judges checking -> checking only: a savings (or cash-in-hand) account on either side passes.
    expect(pairViolation(side('cash', 'itau', null, true), side('cash', 'itau', null, false))).toBeNull();
    expect(pairViolation(side('cash', 'itau', null, false), side('cash', 'itau', null, true))).toBeNull();
    expect(pairViolation(side('cash', 'itau', null, false), side('cash', 'itau', null, false))).toBeNull();
    // One side labelled, the other not, on one connection: the same bank (documented in docs/decisions.md).
    expect(sameBank({ bank: 'itau', connectionId: 'c1' }, { bank: null, connectionId: 'c1' })).toBe(true);
    expect(sameBank({ bank: 'itau', connectionId: 'c1' }, { bank: null, connectionId: 'c2' })).toBeNull();
  });

  test('rule 1: a card outflow is never linked, whatever the evidence; against a card inflow it is a refused suggestion', () => {
    const a = o(itauCard, { hint: SAME_PERSON });
    const b = i(nuCard, { hint: SAME_PERSON });
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      { id: a.id, confidence: 'sure', basis: 'refused', candidateIds: [b.id], violations: { [b.id]: 'card_outflow' } },
    ]);
    // Both rows count as suspected transfers in the register summaries.
    expect(p.rows.get(a.id)).toEqual({ confidence: 'sure', candidateCount: 1, counterpartId: b.id });
    expect(p.rows.get(b.id)).toEqual({ confidence: 'sure', candidateCount: 1, counterpartId: a.id });
  });

  test('a card purchase with a same-amount opposite row in a checking account within 3 days: no suggestion, as on main', () => {
    for (const other of [itauConta, nuConta]) {
      for (const gap of [0, 3]) {
        const purchase = o(itauCard, { date: '2026-11-03', hint: SAME_PERSON });
        const deposit = i(other, { date: `2026-11-0${3 + gap}`, hint: SAME_PERSON });
        const p = plan([purchase, deposit]);
        expect(p.links).toEqual([]);
        expect(p.suggestions.filter((s) => s.id === purchase.id || s.candidateIds.includes(purchase.id))).toEqual([]);
        expect(p.suggestions.some((s) => s.basis === 'refused')).toBe(false);
      }
    }
  });

  test('card refund (card inflow from a merchant) is never linked to a card outflow, only offered', () => {
    for (const [from, to] of [
      [itauCard, nuCard],
      [itauCard, { ...nuCard, bank: 'itau' }],
      [{ accountId: 'card1', accountKind: 'card' as const }, { accountId: 'card2', accountKind: 'card' as const }],
    ]) {
      const purchase = o(from, { date: '2026-11-02', hint: SHOP });
      const refund = i(to, { date: '2026-11-03', hint: SHOP });
      const p = plan([purchase, refund]);
      expect(p.links).toEqual([]);
      expect(p.suggestions.map((s) => [s.id, s.basis, s.candidateIds])).toEqual([[purchase.id, 'refused', [refund.id]]]);
    }
  });

  test('rule 2: checking pays a card only of the same bank (another bank is offered, never linked)', () => {
    const a = o(itauConta);
    const b = i(itauCard);
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
    const c = o(itauConta, { hint: { category: 'Credit card payment', operationType: 'PAGAMENTO_FATURA' } });
    const d = i(nuCard, { hint: { category: 'Credit card payment', operationType: 'PAGAMENTO_FATURA' } });
    const p = plan([c, d]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      { id: c.id, confidence: 'sure', basis: 'refused', candidateIds: [d.id], violations: { [d.id]: 'card_payment_other_bank' } },
    ]);
  });

  test('rule 3: checking to checking only across banks (the same bank is offered, never linked)', () => {
    const a = o(itauConta);
    const b = i(nuConta);
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
    const c = o(nuConta);
    const d = i({ accountId: 'nucheck2', accountKind: 'cash', bank: 'nubank' });
    const p = plan([c, d]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      { id: c.id, confidence: 'sure', basis: 'refused', candidateIds: [d.id], violations: { [d.id]: 'cash_same_bank' } },
    ]);
  });

  test('rule 3 does not apply to savings: same-bank checking <-> savings still links, either way', () => {
    const nuSavings = { accountId: 'nusavings', accountKind: 'cash' as const, bank: 'nubank', checking: false };
    const toSavings = [o(nuConta), i(nuSavings)];
    expect(pairsOf(toSavings)).toEqual([[toSavings[0].id, toSavings[1].id]]);
    const fromSavings = [o(nuSavings), i(nuConta)];
    expect(pairsOf(fromSavings)).toEqual([[fromSavings[0].id, fromSavings[1].id]]);
    // Same connection without labels: also still linked.
    const conn = { connectionId: 'c1' };
    const viaConn = [o({ accountId: 'x', accountKind: 'cash', ...conn }), i({ accountId: 'y', accountKind: 'cash', checking: false, ...conn })];
    expect(pairsOf(viaConn)).toEqual([[viaConn[0].id, viaConn[1].id]]);
    // Cross-bank is unchanged either way.
    const cross = [o(itauConta), i(nuSavings)];
    expect(pairsOf(cross)).toEqual([[cross[0].id, cross[1].id]]);
  });

  test('one side labelled and the other not, on one connection: treated as the same bank', () => {
    const conn = { connectionId: 'c1' };
    // checking -> checking: refused (same bank by connection).
    expect(plan([o({ ...itauConta, ...conn }), i({ accountId: 'y', accountKind: 'cash', ...conn })]).links).toEqual([]);
    // checking -> card: allowed (same bank).
    const a = o({ ...itauConta, ...conn });
    const b = i({ accountId: 'y', accountKind: 'card', ...conn });
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
    // Different connections with one label: unknown, so both rules pass.
    const c = o({ ...itauConta, connectionId: 'c1' });
    const d = i({ accountId: 'y', accountKind: 'cash', connectionId: 'c2' });
    expect(pairsOf([c, d])).toEqual([[c.id, d.id]]);
  });

  test('the chain case: Itaú conta -> Nubank conta -> Nubank cartão, same day, same amount', () => {
    const itauOut = o(itauConta, { hint: PIX });
    const nuIn = i(nuConta, { hint: PIX });
    const cardIn = i(nuCard, { hint: { category: 'Credit card payment', operationType: null } });
    const nuOut = o(nuConta, { hint: { category: 'Credit card payment', operationType: 'PAGAMENTO_FATURA' } });
    const p = plan([itauOut, nuIn, cardIn, nuOut]);
    expect(p.links.map((l) => [l.outflowId, l.inflowId, l.basis]).sort()).toEqual(
      [
        [itauOut.id, nuIn.id, 'unique'],
        [nuOut.id, cardIn.id, 'unique'],
      ].sort(),
    );
    expect(p.suggestions).toEqual([]);
  });

  test('a row whose only candidates break the rules is offered, never linked; one-side only with strong evidence and a valid direction', () => {
    // Itaú conta -> Nubank cartão breaks rule 2: no link, but offered as a pair (never a one-side row each).
    const a = o(itauConta, { hint: SAME_PERSON });
    const b = i(nuCard, { hint: SAME_PERSON });
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((s) => [s.id, s.confidence, s.basis, s.candidateIds])).toEqual([[a.id, 'sure', 'refused', [b.id]]]);
    // A lone card outflow is never a one-side suggestion.
    expect(plan([o(nuCard, { hint: SAME_PERSON })]).suggestions).toEqual([]);
  });

  test('the rules break ties: of two candidates only the one that fits remains', () => {
    // Itaú conta -100 with Itaú cartão +100 and Nubank cartão +100: only Itaú's card fits.
    const a = o(itauConta);
    const b = i(itauCard);
    const c = i(nuCard);
    const p = plan([a, b, c]);
    expect(p.links).toEqual([{ outflowId: a.id, inflowId: b.id, method: 'auto', basis: 'unique' }]);
  });

  test('accounts with an unknown bank keep the old behaviour (except card outflows)', () => {
    const a = o({ accountId: 'itau', accountKind: 'cash' });
    const b = i({ accountId: 'nubank', accountKind: 'cash' });
    const c = i({ accountId: 'nucard', accountKind: 'card' });
    const p = plan([a, b, c]);
    expect(p.suggestions).toEqual([{ id: a.id, confidence: 'choose', basis: 'ambiguous', candidateIds: [b.id, c.id].sort() }]);
    // One side known, the other unknown: still a candidate.
    const d = o(itauConta);
    const e = i({ accountId: 'nucard', accountKind: 'card' });
    expect(pairsOf([d, e])).toEqual([[d.id, e.id]]);
  });

  test('the same connection without labels counts as the same bank', () => {
    const conn = { connectionId: 'c1' };
    expect(plan([o({ accountId: 'x', accountKind: 'cash', ...conn }), i({ accountId: 'y', accountKind: 'cash', ...conn })]).links).toEqual([]);
    const a = o({ accountId: 'x', accountKind: 'cash', ...conn });
    const b = i({ accountId: 'y', accountKind: 'card', ...conn });
    expect(pairsOf([a, b])).toEqual([[a.id, b.id]]);
  });

  test('a card outflow with a payee rule is never a one-side suggestion either (it can never pair)', () => {
    const rules = new Map<string, TransferRule>([['p', { mode: 'auto', accountId: null, noMatch: 'review', waitDays: 2, since: null }]]);
    const purchase = o(nuCard, { payeeId: 'p', date: '2026-11-03' });
    // Past waitDays and no pair possible: no suggestion (the guard for rule-less rows agrees).
    expect(plan([purchase], rules).suggestions).toEqual([]);
    // A card inflow (a payment received) and a cash row keep their one-side suggestion.
    expect(plan([i(nuCard, { payeeId: 'p', date: '2026-11-03' })], rules).suggestions.map((s) => s.confidence)).toEqual(['one_side']);
    expect(plan([o(nuConta, { payeeId: 'p', date: '2026-11-03' })], rules).suggestions.map((s) => s.confidence)).toEqual(['one_side']);
    // Within waitDays it still waits (unchanged).
    const waiting = o(nuCard, { payeeId: 'p', date: '2026-11-22' });
    expect(plan([waiting], rules).pending.get(waiting.id)).toBe('waiting');
  });

  test('a refused pair is never auto-linked: not by evidence, not by an auto payee rule', () => {
    const strong = { category: 'Credit card payment', operationType: 'PAGAMENTO_FATURA' };
    const rules = new Map<string, TransferRule>([['p', { mode: 'auto', accountId: null, noMatch: 'review', waitDays: 5, since: null }]]);
    const a = o(itauConta, { payeeId: 'p', hint: strong });
    const b = i(nuCard, { hint: strong });
    const p = plan([a, b], rules);
    expect(p.links).toEqual([]);
    expect(p.pending.size).toBe(0);
    // The rule row is the suggestion, not also a one-side / waiting row.
    expect(p.suggestions.map((s) => [s.id, s.basis, s.candidateIds])).toEqual([[a.id, 'refused', [b.id]]]);
  });

  test('refused candidates are only offered to rows without an allowed partner', () => {
    // Itaú conta -100: Itaú cartão (allowed) and Nubank cartão (refused). Only the allowed pair shows.
    const a = o(itauConta);
    const b = i(itauCard);
    const c = i(nuCard);
    const p = plan([a, b, c]);
    expect(p.links.map((l) => [l.outflowId, l.inflowId])).toEqual([[a.id, b.id]]);
    expect(p.suggestions).toEqual([]);
  });

  test('several refused candidates are a choose suggestion, closest date first, each with its rule', () => {
    const a = o(itauConta, { date: '2026-11-03' });
    const near = i(nuCard, { date: '2026-11-04' });
    const far = i({ accountId: 'itau2', accountKind: 'cash', bank: 'itau' }, { date: '2026-11-06' });
    const p = plan([a, near, far]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      {
        id: a.id,
        confidence: 'choose',
        basis: 'refused',
        candidateIds: [near.id, far.id],
        violations: { [near.id]: 'card_payment_other_bank', [far.id]: 'cash_same_bank' },
      },
    ]);
    expect(p.rows.get(near.id)).toEqual({ confidence: 'choose', candidateCount: 1, counterpartId: a.id });
  });

  test('a card outflow with a payee rule is offered its refused counterpart, not waiting or one-side', () => {
    const rules = new Map<string, TransferRule>([['p', { mode: 'auto', accountId: null, noMatch: 'outside', waitDays: 2, since: null }]]);
    const a = o(nuCard, { payeeId: 'p', date: '2026-11-03' });
    const b = i(itauCard, { date: '2026-11-03' });
    const p = plan([a, b], rules);
    expect(p.suggestions.map((s) => [s.id, s.basis, s.candidateIds])).toEqual([[a.id, 'refused', [b.id]]]);
    expect(p.pending.size).toBe(0);
  });

  test('a row whose only partner is refused still gets a suggestion when that partner has allowed candidates of its own', () => {
    // Itaú conta +100 is wanted by Nubank conta and BB conta (allowed) and by Itaú conta 2 (same bank: refused).
    const nu = o(nuConta);
    const bb = o({ accountId: 'bb', accountKind: 'cash', bank: 'bb' });
    const itau2 = o({ accountId: 'itau2', accountKind: 'cash', bank: 'itau' });
    const target = i(itauConta);
    const p = plan([nu, bb, itau2, target]);
    expect(p.links).toEqual([]);
    const by = new Map(p.suggestions.map((sug) => [sug.id, sug]));
    expect(by.get(nu.id)).toMatchObject({ confidence: 'choose', basis: 'ambiguous', candidateIds: [target.id] });
    expect(by.get(bb.id)).toMatchObject({ confidence: 'choose', basis: 'ambiguous', candidateIds: [target.id] });
    expect(by.get(itau2.id)).toEqual({
      id: itau2.id,
      confidence: 'choose',
      basis: 'refused',
      candidateIds: [target.id],
      violations: { [target.id]: 'cash_same_bank' },
    });
    expect(p.suggestions).toHaveLength(3);
    expect(p.rows.get(target.id)).toMatchObject({ candidateCount: 3, counterpartId: null });
    // The refused row is not also a one-side row, even with strong evidence on both of its sides.
    const strongItau2 = o({ accountId: 'itau2', accountKind: 'cash', bank: 'itau' }, { hint: SAME_PERSON });
    const strong = plan([o(nuConta), o({ accountId: 'bb', accountKind: 'cash', bank: 'bb' }), strongItau2, i(itauConta, { hint: SAME_PERSON })]);
    expect(strong.suggestions.some((sug) => sug.confidence === 'one_side')).toBe(false);
    expect(strong.suggestions.find((sug) => sug.id === strongItau2.id)?.basis).toBe('refused');
  });

  test('refused candidates join a pair left for the person without changing it, and never join a linked pair', () => {
    // Itaú conta -> Itaú cartão is an allowed pair but the outflow was edited: suggested, not linked.
    const a = o(itauConta, { untouched: false });
    const b = i(itauCard);
    const refusedIn = i({ accountId: 'itau2', accountKind: 'cash', bank: 'itau' });
    expect(pairsOf([a, b])).toEqual([]);
    const p = plan([a, b, refusedIn]);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((sug) => [sug.id, sug.confidence, sug.basis, sug.candidateIds])).toEqual([[a.id, 'choose', 'unique', [b.id, refusedIn.id].sort()]]);
    expect(p.suggestions[0].violations).toEqual({ [refusedIn.id]: 'cash_same_bank' });
    // The same rows with an untouched outflow: the allowed pair links, the refused row is not offered.
    const c = o(itauConta);
    const d = i(itauCard);
    const e = i({ accountId: 'itau2', accountKind: 'cash', bank: 'itau' });
    const q = plan([c, d, e]);
    expect(q.links.map((l) => [l.outflowId, l.inflowId])).toEqual([[c.id, d.id]]);
    expect(q.suggestions).toEqual([]);
  });

  test('rule 2 also judges a savings or cash-in-hand account paying a card at another bank', () => {
    const side = (checking: boolean, bank: string) => ({ accountKind: 'cash' as const, checking, bank, connectionId: null });
    const cardSide = (bank: string) => ({ accountKind: 'card' as const, checking: false, bank, connectionId: null });
    expect(pairViolation(side(false, 'itau'), cardSide('nubank'))).toBe('card_payment_other_bank');
    expect(pairViolation(side(false, 'itau'), cardSide('itau'))).toBeNull();
    const itauSavings = { accountId: 'itausav', accountKind: 'cash' as const, bank: 'itau', checking: false };
    const a = o(itauSavings);
    const b = i(nuCard);
    const p = plan([a, b]);
    expect(p.links).toEqual([]);
    expect(p.suggestions).toEqual([
      { id: a.id, confidence: 'sure', basis: 'refused', candidateIds: [b.id], violations: { [b.id]: 'card_payment_other_bank' } },
    ]);
    const c = o(itauSavings);
    const d = i(itauCard);
    expect(pairsOf([c, d])).toEqual([[c.id, d.id]]);
  });

  test('a payee-rule row whose only partner is refused stays a refused suggestion past waitDays, whatever the no-match policy', () => {
    for (const noMatch of ['outside', 'review'] as const) {
      const rules = new Map<string, TransferRule>([['p', { mode: 'auto', accountId: null, noMatch, waitDays: 2, since: null }]]);
      const a = o(itauConta, { payeeId: 'p', date: '2026-11-03' }); // 20 days old at TODAY
      const b = i(nuCard, { date: '2026-11-03' });
      const p = plan([a, b], rules);
      expect(p.links).toEqual([]);
      expect(p.pending.size).toBe(0);
      expect(p.suggestions.map((sug) => [sug.id, sug.confidence, sug.basis, sug.candidateIds])).toEqual([[a.id, 'sure', 'refused', [b.id]]]);
    }
  });

  test('a fixed-account payee rule is the person\'s choice: the bank rules do not drop it', () => {
    const rules = new Map<string, TransferRule>([['p', { mode: 'account', accountId: 'nucard', noMatch: 'review', waitDays: 5, since: null }]]);
    const a = o(itauConta, { payeeId: 'p' });
    const b = i(nuCard);
    expect(plan([a, b], rules).links).toEqual([{ outflowId: a.id, inflowId: b.id, method: 'rule', basis: 'unique' }]);
    // ...but a card is still never the outflow side.
    const cardRules = new Map<string, TransferRule>([['p', { mode: 'account', accountId: 'nubank', noMatch: 'review', waitDays: 5, since: null }]]);
    expect(plan([o(nuCard, { payeeId: 'p', date: '2026-11-20' }), i(nuConta, { date: '2026-11-20' })], cardRules).links).toEqual([]);
  });
});

describe('import hints (budget-nq2f)', () => {
  test('a hinted row pairs only with a row of the hinted account (unique there), instead of being ambiguous', () => {
    const a = out({ hintAccountId: 'nubank' });
    const right = inn();
    const other = inn({ accountId: 'bradesco' });
    expect(plan([out(), inn(), inn({ accountId: 'bradesco' })], noRules).links).toEqual([]); // two candidates: nothing without the hint
    const p = plan([a, right, other], noRules);
    expect(p.links).toEqual([{ outflowId: a.id, inflowId: right.id, method: 'auto', basis: 'unique' }]);
    // The other side hinted at a different account never pairs.
    const wrong = out({ hintAccountId: 'bradesco' });
    expect(plan([wrong, inn()], noRules).links).toEqual([]);
  });

  test('a lone hinted row is a one-side suggestion (strong evidence), a lone plain row is nothing', () => {
    const hinted = out({ hintAccountId: 'nubank' });
    expect(plan([hinted], noRules).suggestions).toEqual([{ id: hinted.id, confidence: 'one_side', basis: 'unmatched', candidateIds: [] }]);
    expect(plan([out()], noRules).suggestions).toEqual([]);
    // A card purchase is never a transfer, hint or not.
    expect(plan([card({ amount: -3_000_000, hintAccountId: 'nubank' })], noRules).suggestions).toEqual([]);
  });

  test('the bank rules still apply to a hinted pair: a refused pair is suggested, never linked', () => {
    const a = out({ hintAccountId: 'nucard', bank: 'itau' });
    const b = card({ bank: 'nubank' });
    const p = plan([a, b], noRules);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((sug) => [sug.id, sug.basis])).toEqual([[a.id, 'refused']]);
  });

  test('a hint never overrides the bank\'s contradicting category: no auto-link, no one-side suggestion', () => {
    const a = out({ hintAccountId: 'nubank', hint: SHOP });
    const b = inn();
    const p = plan([a, b], noRules);
    expect(p.links).toEqual([]);
    expect(p.suggestions.map((sug) => [sug.id, sug.confidence])).toEqual([[a.id, 'sure']]);
    const lone = out({ hintAccountId: 'nubank', hint: SHOP });
    expect(plan([lone], noRules).suggestions).toEqual([]);
    // Without the contradicting category the same pair links, as before.
    expect(plan([out({ hintAccountId: 'nubank' }), inn()], noRules).links).toHaveLength(1);
  });
});
