/**
 * Categorizer engine against Postgres with a fake provider (no HTTP, no real
 * key): payee-rule short-circuit, model answers, idempotent re-runs, invalid
 * ids, mid-run categorization, the per-kind retry policy, cancellation and the
 * "no key in any result" rule.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { configureAiEnv, setProviders, storeOwnKey, AiProviderError, type AiChatResult } from '../ai';
import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { prepareRun, runChunk, type ChunkParams } from './chunk';
import { CategorizeError } from './errors';
import { answer, fakeProviders, toolTurn } from './fake-provider';
import { cleanupFixtures, newBudget, newCategory, newPayee, newTransaction, suggestionsOf, type BudgetFixture } from './test-fixtures';

const KEY = 'sk-test-owner-0123456789abcdef';
let a: BudgetFixture;
let b: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  a = await newBudget('run-a');
  b = await newBudget('run-b');
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  configureAiEnv({});
  await storeOwnKey(pool, a.userId, 'openai', KEY, 'fake-model');
});

afterAll(async () => {
  if (!dbReady) return;
  setProviders(null);
  configureSecretBox(null);
  await cleanupFixtures();
});

const run = (fx: BudgetFixture, params: Partial<ChunkParams> = {}) =>
  runChunk(pool, { budgetId: fx.budgetId, offset: 0, limit: 10, total: 1, ...params });

const uncategorized = (fx: BudgetFixture, date = '2026-11-01', extra: { payeeId?: string } = {}) =>
  newTransaction({ budgetId: fx.budgetId, accountId: fx.accountId, date, amount: -2500, ...extra });

describe.skipIf(!dbReady)('categorizer run', () => {
  test('stores the model suggestion and an identical re-run upserts in place', async () => {
    const fake = fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9, reason: 'grocery store' }]));
    setProviders(fake.table);
    const txn = await uncategorized(a);

    const first = await run(a);
    expect(first).toMatchObject({ examined: 1, suggested: 1, rule: 0, failed: 0, skipped: 0 });
    const rows = await suggestionsOf(txn);
    expect(rows).toEqual([
      {
        rank: 1,
        category_id: a.food,
        confidence: 0.9,
        reason: 'grocery store',
        source: 'ai',
        provider: 'openai',
        model: 'fake-model',
        status: 'pending',
      },
    ]);
    // The job never writes transactions.category_id.
    expect((await pool.query('select category_id from public.transactions where id = $1', [txn])).rows[0].category_id).toBeNull();

    const second = await run(a);
    expect(second).toMatchObject({ suggested: 1, skipped: 0 });
    expect(await suggestionsOf(txn)).toEqual(rows);
  });

  test('drops ids of another budget, unknown ids and duplicates; keeps the best confidence', async () => {
    const extra = await newCategory(a.budgetId, a.groupId, 'Household');
    const fake = fakeProviders(() =>
      answer([
        { category_id: b.food, confidence: 0.99 },
        { category_id: 'not-a-category', confidence: 0.98 },
        { category_id: a.food, confidence: 0.4 },
        { category_id: a.food, confidence: 0.7 },
        { category_id: extra, confidence: 0.6 },
      ]),
    );
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ suggested: 1 });
    const rows = await suggestionsOf(txn);
    expect(rows.map((row) => [row.rank, row.category_id, row.confidence])).toEqual([
      [1, a.food, 0.7],
      [2, extra, 0.6],
    ]);
    expect(rows.some((row) => row.category_id === b.food)).toBe(false);
  });

  test('keeps at most three suggestions, best confidence first', async () => {
    const second = await newCategory(a.budgetId, a.groupId, 'Household');
    const third = await newCategory(a.budgetId, a.groupId, 'Transport');
    const fake = fakeProviders(() =>
      answer([
        { category_id: a.food, confidence: 0.3 },
        { category_id: a.dining, confidence: 0.9 },
        { category_id: second, confidence: 0.6 },
        { category_id: third, confidence: 0.5 },
      ]),
    );
    setProviders(fake.table);
    const txn = await uncategorized(a);

    await run(a);
    expect((await suggestionsOf(txn)).map((row) => [row.rank, row.category_id])).toEqual([
      [1, a.dining],
      [2, second],
      [3, third],
    ]);
  });

  test('the existing payee rule answers first: no model call, source payee_rule', async () => {
    const payee = await newPayee(a.budgetId, 'Favorite Cafe', { mode: 'fixed', defaultCategoryId: a.dining });
    const fake = fakeProviders(() => {
      throw new Error('the model must not be called for a payee-rule transaction');
    });
    setProviders(fake.table);
    const txn = await uncategorized(a, '2026-11-02', { payeeId: payee });

    expect(await run(a)).toMatchObject({ examined: 1, rule: 1, suggested: 0, failed: 0 });
    expect(fake.calls).toHaveLength(0);
    expect(await suggestionsOf(txn)).toEqual([
      { rank: 1, category_id: a.dining, confidence: 1, reason: null, source: 'payee_rule', provider: null, model: null, status: 'pending' },
    ]);
  });

  test('a transaction categorized by hand mid-run gets no suggestion', async () => {
    const fake = fakeProviders(async () => {
      await pool.query('update public.transactions set category_id = $2 where id = $1', [txn, a.food]);
      return answer([{ category_id: a.dining, confidence: 0.9 }]);
    });
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 0, skipped: 1 });
    expect(await suggestionsOf(txn)).toEqual([]);
    expect((await pool.query('select category_id from public.transactions where id = $1', [txn])).rows[0].category_id).toBe(a.food);
  });

  test('an empty answer writes nothing and clears stale pending ranks', async () => {
    const txn = await uncategorized(a);
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source)
       values ($1, $2, 1, $3, 0.9, 'ai'), ($1, $2, 2, $4, 0.5, 'ai')`,
      [txn, a.budgetId, a.food, a.dining],
    );
    setProviders(fakeProviders(() => answer([])).table);

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 0, empty: 1 });
    expect(await suggestionsOf(txn)).toEqual([]);
  });

  test('a re-run that answers fewer ranks drops the extra pending row', async () => {
    let call = 0;
    setProviders(
      fakeProviders(() =>
        ++call === 1
          ? answer([
              { category_id: a.food, confidence: 0.9 },
              { category_id: a.dining, confidence: 0.4 },
            ])
          : answer([{ category_id: a.food, confidence: 0.9 }]),
      ).table,
    );
    const txn = await uncategorized(a);
    await run(a);
    expect((await suggestionsOf(txn)).map((row) => row.rank)).toEqual([1, 2]);
    await run(a);
    expect((await suggestionsOf(txn)).map((row) => row.rank)).toEqual([1]);
  });

  test('the run classifies only its own budget\'s transactions', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);
    const foreign = await uncategorized(b);
    const own = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 1 });
    expect(await suggestionsOf(foreign)).toEqual([]);
    expect((await suggestionsOf(own)).length).toBe(1);
  });

  test('passes the tool loop through and echoes rawContent unchanged', async () => {
    const rawContent = [{ type: 'thinking', thinking: 'check categories', signature: 'sig-1' }];
    const fake = fakeProviders((request, call) =>
      call === 1 ? { ...toolTurn('list_categories', {}), rawContent } : answer([{ category_id: a.food, confidence: 0.9 }]),
    );
    setProviders(fake.table);
    await uncategorized(a);

    const result = await run(a);
    expect(result).toMatchObject({ suggested: 1 });
    if ('usage' in result) expect(result.usage).toEqual({ input: 17, output: 8 });
    expect(fake.calls).toHaveLength(2);
    const messages = fake.calls[1]!.request.messages;
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('UNTRUSTED DATA');
    expect(messages[2]).toMatchObject({ role: 'assistant', rawContent });
    expect(messages[3]!.role).toBe('tool');
    expect(messages[3]!.content).toContain(a.food);
  });

  test('a non-JSON answer gets one schema-enforced repair turn', async () => {
    const fake = fakeProviders((request, call) =>
      call === 1
        ? { text: 'I am not sure, maybe groceries.', toolCalls: [], model: 'fake-model', finishReason: 'stop', usage: { input: 4, output: 2 } }
        : answer([{ category_id: a.food, confidence: 0.8 }]),
    );
    setProviders(fake.table);
    await uncategorized(a);

    expect(await run(a)).toMatchObject({ suggested: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.request.tools).toBeUndefined();
    expect(fake.calls[1]!.request.jsonSchema?.name).toBe('category_suggestions');
  });
});

describe.skipIf(!dbReady)('retry policy by provider error kind', () => {
  test('timeout is retried once for the transaction and then succeeds', async () => {
    const fake = fakeProviders((request, call) => {
      if (call === 1) throw new AiProviderError('timeout', 'slow');
      return answer([{ category_id: a.food, confidence: 0.9 }]);
    });
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 1, failed: 0 });
    expect(fake.calls).toHaveLength(2);
    expect((await suggestionsOf(txn)).length).toBe(1);
  });

  test('a second timeout marks that transaction failed and the run continues', async () => {
    const firstTxn = await uncategorized(a, '2026-11-05');
    const secondTxn = await uncategorized(a, '2026-11-04');
    const fake = fakeProviders((request, call) => {
      if (call <= 2) throw new AiProviderError('timeout', 'slow');
      return answer([{ category_id: a.food, confidence: 0.9 }]);
    });
    setProviders(fake.table);

    const result = await run(a, { total: 2 });
    expect(result).toMatchObject({ examined: 2, suggested: 1, failed: 1 });
    if ('failedIds' in result) expect(result.failedIds).toEqual([firstTxn]);
    expect(await suggestionsOf(firstTxn)).toEqual([]);
    expect((await suggestionsOf(secondTxn)).length).toBe(1);
  });

  test('bad_response fails the transaction without a second attempt and the run continues', async () => {
    const firstTxn = await uncategorized(a, '2026-11-05');
    const secondTxn = await uncategorized(a, '2026-11-04');
    const fake = fakeProviders((request, call) => {
      if (call === 1) throw new AiProviderError('bad_response', 'garbage');
      return answer([{ category_id: a.food, confidence: 0.9 }]);
    });
    setProviders(fake.table);

    const result = await run(a, { total: 2 });
    expect(result).toMatchObject({ examined: 2, suggested: 1, failed: 1 });
    if ('failedIds' in result) expect(result.failedIds).toEqual([firstTxn]);
    expect(fake.calls).toHaveLength(2);
    expect((await suggestionsOf(secondTxn)).length).toBe(1);
  });

  for (const kind of ['auth', 'permanent', 'rate_limited', 'transient'] as const) {
    test(`${kind} stops the run and writes nothing for the transaction`, async () => {
      setProviders(fakeProviders(() => Promise.reject(new AiProviderError(kind, 'refused', null, 12_000))).table);
      const txn = await uncategorized(a);
      await expect(run(a)).rejects.toBeInstanceOf(CategorizeError);
      await expect(run(a)).rejects.toMatchObject({ kind });
      expect(await suggestionsOf(txn)).toEqual([]);
    });
  }

  test('a provider error never leaks its upstream text into the categorize error', async () => {
    setProviders(fakeProviders(() => Promise.reject(new AiProviderError('auth', 'upstream said: key abc123 rejected'))).table);
    await uncategorized(a);
    const error = await run(a).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as Error).message).not.toContain('abc123');
    expect((error as Error).message).not.toContain('upstream');
  });
});

describe.skipIf(!dbReady)('cancellation and key handling', () => {
  test('cancelling the activity signal aborts the in-flight provider call', async () => {
    const controller = new AbortController();
    let sawAbort = false;
    setProviders(
      fakeProviders((request) => {
        const { promise, reject } = Promise.withResolvers<AiChatResult>();
        request.signal?.addEventListener('abort', () => {
          sawAbort = true;
          reject(new AiProviderError('timeout', 'aborted'));
        });
        // The signal the adapter holds is the caller's: abort it mid-call.
        controller.abort();
        return promise;
      }).table,
    );
    const txn = await uncategorized(a);

    await expect(run(a, { signal: controller.signal })).rejects.toMatchObject({ name: 'CancelledFailure' });
    expect(sawAbort).toBe(true);
    expect(await suggestionsOf(txn)).toEqual([]);
  });

  test('the run key is the budget owner\'s own key, not another user\'s', async () => {
    const other = await newBudget('run-other-user');
    await storeOwnKey(pool, other.userId, 'openai', 'sk-test-member-9876543210fedcba', 'fake-model');
    const fake = fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }]));
    setProviders(fake.table);
    await uncategorized(a);

    await run(a);
    expect(fake.calls[0]!.apiKey).toBe(KEY);
  });

  test('prepare ends at once without a usable key and makes no provider call', async () => {
    const bare = await newBudget('run-bare');
    const fake = fakeProviders(() => answer([]));
    setProviders(fake.table);

    // The fresh owner has no ai_credentials and the shared key is not configured.
    expect(await prepareRun(pool, bare.budgetId)).toEqual({ problem: 'own_key_required' });
    expect(fake.calls).toHaveLength(0);
  });

  test('prepare reports a key saved without a model', async () => {
    const bare = await newBudget('run-no-model');
    await storeOwnKey(pool, bare.userId, 'openai', 'sk-test-no-model-0123456789', null);
    await uncategorized(bare);
    setProviders(fakeProviders(() => answer([])).table);

    expect(await prepareRun(pool, bare.budgetId)).toEqual({ problem: 'no_model' });
    expect(await run(bare)).toEqual({ problem: 'no_model' });
  });

  test('no activity result or workflow-visible value contains the key', async () => {
    const fake = fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }]));
    setProviders(fake.table);
    await uncategorized(a);

    const prepared = await prepareRun(pool, a.budgetId);
    const chunk = await run(a);
    // The fake did receive the key (proves it was resolved), but it never
    // appears in a result, and no request message carries it either.
    expect(fake.calls[0]!.apiKey).toBe(KEY);
    for (const value of [prepared, chunk]) expect(JSON.stringify(value)).not.toContain(KEY);
    for (const call of fake.calls) expect(JSON.stringify(call.request)).not.toContain(KEY);
  });
});
