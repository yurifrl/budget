/**
 * The Jev call against a stubbed fetch: what a usable answer becomes, and the
 * named failure kinds every unusable answer maps to.
 */
import { describe, expect, test } from 'bun:test';

import { classifyTransaction, JEV_MODEL, JevFailure, redactKey, type JevCall } from './call';

const KEY = 'sk-or-v1-0123456789abcdef';
const OPTIONS = [
  { id: '11111111-1111-4111-8111-111111111111', label: 'Food / Groceries' },
  { id: '22222222-2222-4222-8222-222222222222', label: 'Food / Restaurants' },
  { id: '33333333-3333-4333-8333-333333333333', label: 'Home / Rent' },
  { id: '44444444-4444-4444-8444-444444444444', label: 'Fun / Games' },
];

const call = (fetchImpl: typeof fetch, options = OPTIONS): JevCall => ({
  key: KEY,
  facts: {
    payee: 'Mercado Central',
    bankText: 'PIX MERCADO CENTRAL',
    memo: 'compra da semana',
    amount: -58900,
    date: '2026-11-20',
    account: { name: 'Checking', kind: 'checking' },
    counterpart: { found: false, account: null },
    payeeHistory: ['Food / Groceries'],
  },
  options,
  fetchImpl,
});

const answering = (body: unknown, status = 200): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

const choice = (probabilities: Record<string, number>) => ({
  answers: { category: { type: 'choice', probabilities } },
});

describe('classifyTransaction', () => {
  test('returns the three most probable offered categories, best first', async () => {
    const { suggestions } = await classifyTransaction(
      call(
        answering(
          choice({
            [OPTIONS[3]!.id]: 0.05,
            [OPTIONS[0]!.id]: 0.71,
            [OPTIONS[1]!.id]: 0.21,
            [OPTIONS[2]!.id]: 0.03,
            '99999999-9999-4999-8999-999999999999': 0.9,
          }),
        ),
      ),
    );
    expect(suggestions).toEqual([
      { categoryId: OPTIONS[0]!.id, transferAccountId: null, confidence: 0.71 },
      { categoryId: OPTIONS[1]!.id, transferAccountId: null, confidence: 0.21 },
      { categoryId: OPTIONS[3]!.id, transferAccountId: null, confidence: 0.05 },
    ]);
  });

  test('a transfer option answers with the account it names, never a category', async () => {
    const account = '55555555-5555-4555-8555-555555555555';
    const { suggestions } = await classifyTransaction(
      call(
        answering(
          choice({
            [`transfer:${account}`]: 0.8,
            [OPTIONS[0]!.id]: 0.15,
          }),
        ),
        [...OPTIONS, { id: `transfer:${account}`, label: 'Transfer / Savings' }],
      ),
    );
    expect(suggestions).toEqual([
      { categoryId: null, transferAccountId: account, confidence: 0.8 },
      { categoryId: OPTIONS[0]!.id, transferAccountId: null, confidence: 0.15 },
    ]);
  });

  test('"not a transfer" winning is no suggestion at all, never a target', async () => {
    const account = '55555555-5555-4555-8555-555555555555';
    const { suggestions } = await classifyTransaction(
      call(
        answering(
          choice({
            not_transfer: 0.7,
            [`transfer:${account}`]: 0.3,
          }),
        ),
        [{ id: `transfer:${account}`, label: 'Transfer / Savings' }, { id: 'not_transfer', label: 'Not a transfer' }],
      ),
    );
    expect(suggestions).toEqual([]);
  });

  test('sends the payee history and milliunits converted to currency units', async () => {
    let sent: Record<string, unknown> | null = null;
    const capture = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return new Response(JSON.stringify(choice({ [OPTIONS[0]!.id]: 1 })), { status: 200 });
    }) as unknown as typeof fetch;

    await classifyTransaction(call(capture));
    const state = sent!.state as Record<string, unknown>;
    expect(state.amount).toBe(-58.9);
    expect(state.same_payee_categorized_before_as).toEqual(['Food / Groceries']);
    expect(state.memo).toBe('compra da semana');
    expect((sent!.questions as Record<string, { criteria: Record<string, string> }>).category!.criteria).toEqual(
      Object.fromEntries(OPTIONS.map((option) => [option.id, option.label])),
    );
  });

  test('a refusal is a failure, never a guess', async () => {
    const failure = await classifyTransaction(call(answering({ answers: { category: { type: 'refusal' } } }))).catch(
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(JevFailure);
    expect((failure as JevFailure).kind).toBe('refusal');
  });

  test('another answer type is named as such', async () => {
    const failure = await classifyTransaction(
      call(answering({ answers: { category: { type: 'ranking', order: [] } } })),
    ).catch((err: unknown) => err);
    expect((failure as JevFailure).kind).toBe('answer_type');
  });

  test('an answer that is not the documented shape is a schema mismatch', async () => {
    const noJson = (async () => new Response('not json', { status: 200 })) as unknown as typeof fetch;
    expect(((await classifyTransaction(call(noJson)).catch((err: unknown) => err)) as JevFailure).kind).toBe(
      'schema_mismatch',
    );

    const notAnAnswer = await classifyTransaction(call(answering({ answers: {} }))).catch((err: unknown) => err);
    expect((notAnAnswer as JevFailure).kind).toBe('schema_mismatch');
  });

  test('a non-2xx names what it means: 5xx server, 402 no credits, 429 rate limit, 401 rejected key', async () => {
    const kindOf = (status: number) =>
      classifyTransaction(call(answering({ error: 'boom' }, status))).catch((err: unknown) => (err as JevFailure).kind);
    expect(await kindOf(500)).toBe('server');
    expect(await kindOf(402)).toBe('no_credits');
    expect(await kindOf(429)).toBe('rate_limited');
    expect(await kindOf(401)).toBe('rejected_key');
  });

  test('a timeout is a timeout failure', async () => {
    const timingOut = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    const failure = await classifyTransaction(call(timingOut)).catch((err: unknown) => err);
    expect((failure as JevFailure).kind).toBe('timeout');
  });

  test('a key planted in the answer never comes back in the failure text', async () => {
    const failure = await classifyTransaction(call(answering({ error: `invalid key ${KEY}` }, 500))).catch(
      (err: unknown) => err,
    );
    expect((failure as JevFailure).message).not.toContain(KEY);
    expect((failure as JevFailure).message).toContain('[key]');
    expect(redactKey(`two ${KEY} ${KEY}`, KEY)).toBe('two [key] [key]');
  });

  test('a reported model id is kept only when it looks like one, else the model we asked for', async () => {
    const withModel = (model: unknown) => answering({ ...choice({ [OPTIONS[0]!.id]: 0.9 }), model });

    const kept = await classifyTransaction(call(withModel('typesafe/jev-1.13-20260917')));
    expect(kept.model).toBe('typesafe/jev-1.13-20260917');

    const tooLong = await classifyTransaction(call(withModel('x'.repeat(101))));
    expect(tooLong.model).toBe(JEV_MODEL);

    const notAnId = await classifyTransaction(call(withModel('typesafe/jev 1.13 <script>')));
    expect(notAnId.model).toBe(JEV_MODEL);

    const missing = await classifyTransaction(call(withModel(undefined)));
    expect(missing.model).toBe(JEV_MODEL);
  });
});

/**
 * The one test that talks to Jev for real: made-up data, skipped unless
 * JEV_API_KEY is set. It proves the request shape and the answer schema still
 * match the live model.
 */
test.skipIf(!process.env.JEV_API_KEY)('a real call with made-up data answers in the documented shape', async () => {
  const { suggestions, model } = await classifyTransaction({
    key: process.env.JEV_API_KEY!,
    facts: {
      payee: 'Padaria Exemplo',
      bankText: 'CARTAO PADARIA EXEMPLO',
      memo: null,
      amount: -1550,
      date: '2026-01-15',
      account: { name: 'Conta Corrente', kind: 'checking' },
      counterpart: { found: false, account: null },
      payeeHistory: ['Food / Groceries'],
    },
    options: OPTIONS,
  });
  expect(suggestions.length).toBeGreaterThan(0);
  expect(typeof model).toBe('string');
  const offered = OPTIONS.map((option) => option.id);
  for (const suggestion of suggestions) {
    const target = suggestion.categoryId ?? suggestion.transferAccountId ?? null;
    expect(target).not.toBeNull();
    expect(offered).toContain(target as string);
    expect(suggestion.confidence).toBeGreaterThan(0);
    expect(suggestion.confidence).toBeLessThanOrEqual(1);
  }
});

/**
 * The one thing only the live model can prove: given a bank row that says it is
 * a transfer between the person's own accounts, and a counterpart account to
 * name, Jev answers with a transfer rather than a spending category. Skipped
 * without a key, like the shape test above.
 */
test.skipIf(!process.env.JEV_API_KEY)('a real call answers a PIX entre contas row with a transfer', async () => {
  const account = '55555555-5555-4555-8555-555555555555';
  const { suggestions } = await classifyTransaction({
    key: process.env.JEV_API_KEY!,
    facts: {
      payee: 'Joao Da Silva',
      bankText: 'PIX TRANSFERENCIA ENTRE CONTAS',
      memo: 'transferencia',
      amount: 250000,
      date: '2026-01-16',
      account: { name: 'Conta Corrente', kind: 'checking' },
      counterpart: { found: true, account: 'Poupanca' },
      payeeHistory: [],
    },
    options: [
      { id: '11111111-1111-4111-8111-111111111111', label: 'Food / Groceries' },
      { id: `transfer:${account}`, label: 'Transfer / Poupanca' },
      { id: 'not_transfer', label: 'Not a transfer' },
    ],
  });
  expect(suggestions[0]).toMatchObject({ categoryId: null, transferAccountId: account });
});
