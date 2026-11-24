/**
 * Categorizer engine against Postgres with a fake provider (no HTTP, no real
 * key): payee-rule short-circuit, model answers, idempotent re-runs, invalid
 * ids, mid-run categorization, decided suggestions, the per-kind retry policy,
 * keyset walking, heartbeat resume, token accounting, cancellation and the
 * "no key in any result" rule.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { configureAiEnv, storeOwnKey, AiProviderError, type AiChatResult } from '../ai';
import { setProviders } from '../ai/providers';
import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { prepareRun, runChunk, type ChunkParams, type ChunkProgress } from './chunk';
import { CategorizeError } from './errors';
import { answer, fakeProviders, toolTurn } from './testing';
import {
  cleanupFixtures,
  newAccount,
  newBudget,
  newCategory,
  newPayee,
  newTransaction,
  suggestionsOf,
  type BudgetFixture,
} from './testing';

const KEY = 'sk-test-owner-0123456789abcdef';
const MAX = { date: '9999-12-31', id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' };
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
  runChunk(pool, { budgetId: fx.budgetId, force: false, snapshot: MAX, cursor: null, limit: 10, total: 1, ...params });

const uncategorized = (fx: BudgetFixture, date = '2026-11-01', extra: Partial<Parameters<typeof newTransaction>[0]> = {}) =>
  newTransaction({ budgetId: fx.budgetId, accountId: fx.accountId, date, amount: -2500, ...extra });

const attemptOf = async (transactionId: string) =>
  (
    await pool.query(
      'select outcome, error_kind, attempts, model, last_attempt_at from public.categorize_attempts where transaction_id = $1',
      [transactionId],
    )
  ).rows[0];

describe.skipIf(!dbReady)('categorizer run', () => {
  test('stores the model suggestion and a forced re-run upserts in place', async () => {
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

    const second = await run(a, { force: true });
    expect(second).toMatchObject({ examined: 1, suggested: 1, skipped: 0 });
    expect(await suggestionsOf(txn)).toEqual(rows);
  });

  test('drops ids of another budget, unknown ids and duplicates; keeps the best confidence', async () => {
    const extra = await newCategory(a.budgetId, a.groupId, 'Household');
    setProviders(
      fakeProviders(() =>
        answer([
          { category_id: b.food, confidence: 0.99 },
          { category_id: 'not-a-category', confidence: 0.98 },
          { category_id: a.food, confidence: 0.4 },
          { category_id: a.food, confidence: 0.7 },
          { category_id: extra, confidence: 0.6 },
        ]),
      ).table,
    );
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
    setProviders(
      fakeProviders(() =>
        answer([
          { category_id: a.food, confidence: 0.3 },
          { category_id: a.dining, confidence: 0.9 },
          { category_id: second, confidence: 0.6 },
          { category_id: third, confidence: 0.5 },
        ]),
      ).table,
    );
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

  test('a payee rule pointing at a hidden category is ignored and the model answers', async () => {
    const payee = await newPayee(a.budgetId, 'Hidden Favorite', { mode: 'fixed', defaultCategoryId: a.hidden });
    const fake = fakeProviders(() => answer([{ category_id: a.food, confidence: 0.8 }]));
    setProviders(fake.table);
    const txn = await uncategorized(a, '2026-11-02', { payeeId: payee });

    expect(await run(a)).toMatchObject({ rule: 0, suggested: 1 });
    expect(fake.calls.length).toBeGreaterThan(0);
    const rows = await suggestionsOf(txn);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category_id: a.food, source: 'ai' });
  });

  test('a transaction categorized by hand mid-run gets no suggestion', async () => {
    const txn = await uncategorized(a);
    setProviders(
      fakeProviders(async () => {
        await pool.query('update public.transactions set category_id = $2 where id = $1', [txn, a.food]);
        return answer([{ category_id: a.dining, confidence: 0.9 }]);
      }).table,
    );

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 0, skipped: 1 });
    expect(await suggestionsOf(txn)).toEqual([]);
    expect((await pool.query('select category_id from public.transactions where id = $1', [txn])).rows[0].category_id).toBe(a.food);
  });

  test('an empty answer clears stale pending ranks', async () => {
    const txn = await uncategorized(a);
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source)
       values ($1, $2, 1, $3, 0.9, 'ai'), ($1, $2, 2, $4, 0.5, 'ai')`,
      [txn, a.budgetId, a.food, a.dining],
    );
    setProviders(fakeProviders(() => answer([])).table);

    expect(await run(a, { force: true })).toMatchObject({ examined: 1, suggested: 0, empty: 1 });
    expect(await suggestionsOf(txn)).toEqual([]);
  });

  test('a forced re-run that answers fewer ranks drops the extra pending row', async () => {
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
    await run(a, { force: true });
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

  test('passes the tool loop through, echoes rawContent and survives a non-uuid tool guess', async () => {
    const rawContent = [{ type: 'thinking', thinking: 'check categories', signature: 'sig-1' }];
    const fake = fakeProviders((request, call) =>
      call === 1
        ? { ...toolTurn('get_transaction', { transaction_id: 'txn_1' }), rawContent }
        : call === 2
          ? toolTurn('list_categories', {})
          : answer([{ category_id: a.food, confidence: 0.9 }]),
    );
    setProviders(fake.table);
    await uncategorized(a);

    const result = await run(a);
    expect(result).toMatchObject({ suggested: 1 });
    if ('usage' in result) expect(result.usage).toEqual({ input: 24, output: 11 });
    expect(fake.calls).toHaveLength(3);
    // M1: the invalid id became a tool error the model could read, so the run
    // continued instead of failing and re-billing the chunk.
    expect(fake.calls[1]!.request.messages[2]).toMatchObject({ role: 'assistant', rawContent });
    expect(fake.calls[1]!.request.messages[3]).toMatchObject({ role: 'tool' });
    expect(fake.calls[1]!.request.messages[3]!.content).toContain('invalid arguments');
    expect(fake.calls[2]!.request.messages[5]!.role).toBe('tool');
    expect(fake.calls[2]!.request.messages[5]!.content).toContain(a.food);
  });

  test('a non-JSON answer gets one schema-enforced repair turn with tools still declared', async () => {
    const fake = fakeProviders((request, call) =>
      call === 1
        ? { text: 'I am not sure, maybe groceries.', toolCalls: [], model: 'fake-model', finishReason: 'stop', usage: { input: 4, output: 2 } }
        : answer([{ category_id: a.food, confidence: 0.8 }]),
    );
    setProviders(fake.table);
    await uncategorized(a);

    expect(await run(a)).toMatchObject({ suggested: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.request.tools?.map((tool) => tool.name)).toEqual([
      'list_categories',
      'get_transaction',
      'payee_history',
      'search_similar_transactions',
    ]);
    expect(fake.calls[1]!.request.toolChoice).toBe('none');
    expect(fake.calls[1]!.request.jsonSchema?.name).toBe('category_suggestions');
  });
});

describe.skipIf(!dbReady)('decided suggestions are never rewritten', () => {
  test('a dismissed row survives a forced re-run and the model is not even called', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);
    const txn = await uncategorized(a);
    await run(a);
    await pool.query(`update public.category_suggestions set status = 'dismissed' where transaction_id = $1`, [txn]);

    const fake = fakeProviders(() => answer([{ category_id: a.dining, confidence: 0.9 }]));
    setProviders(fake.table);
    const result = await run(a, { force: true });
    expect(result).toMatchObject({ examined: 1, suggested: 0, skipped: 1 });
    expect(fake.calls).toHaveLength(0);
    expect(await suggestionsOf(txn)).toEqual([
      { rank: 1, category_id: a.food, confidence: 0.9, reason: 'evidence', source: 'ai', provider: 'openai', model: 'fake-model', status: 'dismissed' },
    ]);
  });

  test('an accepted row is not hidden behind a new pending one at its rank', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);
    const txn = await uncategorized(a);
    await run(a);
    await pool.query(`update public.category_suggestions set status = 'accepted' where transaction_id = $1`, [txn]);

    const fake = fakeProviders(() => answer([{ category_id: a.dining, confidence: 0.9 }]));
    setProviders(fake.table);
    expect(await run(a, { force: true })).toMatchObject({ skipped: 1 });
    expect(fake.calls).toHaveLength(0);
    expect((await suggestionsOf(txn)).map((row) => [row.category_id, row.status])).toEqual([[a.food, 'accepted']]);
  });

  test('an answer with only unknown ids never deletes pending rows', async () => {
    const txn = await uncategorized(a);
    await pool.query(
      `insert into public.category_suggestions (transaction_id, budget_id, rank, category_id, confidence, source)
       values ($1, $2, 1, $3, 0.7, 'ai')`,
      [txn, a.budgetId, a.food],
    );
    const unknown = () => answer([{ category_id: '11111111-2222-4333-8444-555555555555', confidence: 0.9 }]);
    setProviders(fakeProviders(unknown).table);

    expect(await run(a, { force: true })).toMatchObject({ examined: 1, failed: 1 });
    expect((await suggestionsOf(txn)).map((row) => [row.category_id, row.status])).toEqual([[a.food, 'pending']]);
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

  test('a timeout retry reports the whole transaction usage once, not per attempt', async () => {
    setProviders(
      fakeProviders((request, call) => {
        if (call === 1) return toolTurn('list_categories', {});
        if (call === 2) throw new AiProviderError('timeout', 'slow');
        return answer([{ category_id: a.food, confidence: 0.9 }]);
      }).table,
    );
    await uncategorized(a);
    const result = await run(a);
    if (!('usage' in result)) throw new Error('expected a chunk window');
    // tool turn 7/3 + answer 10/5; the timeout attempt reported the same 7/3
    // as part of its cumulative usage and nothing is counted twice.
    expect(result).toMatchObject({ suggested: 1, failed: 0 });
    expect(result.usage).toEqual({ input: 17, output: 8 });
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

  test('a per-transaction 400 fails only that transaction; a 404 stops the run', async () => {
    const firstTxn = await uncategorized(a, '2026-11-05');
    const secondTxn = await uncategorized(a, '2026-11-04');
    let call = 0;
    setProviders(
      fakeProviders(() => {
        call++;
        if (call === 1) throw new AiProviderError('permanent', 'context length exceeded', 400);
        return answer([{ category_id: a.food, confidence: 0.9 }]);
      }).table,
    );
    const result = await run(a, { total: 2 });
    expect(result).toMatchObject({ examined: 2, suggested: 1, failed: 1 });
    if ('failedIds' in result) expect(result.failedIds).toEqual([firstTxn]);
    expect((await suggestionsOf(secondTxn)).length).toBe(1);

    setProviders(fakeProviders(() => Promise.reject(new AiProviderError('permanent', 'model not found', 404))).table);
    const stopped = await run(a, { force: true, total: 2 }).catch((e: unknown) => e);
    expect(stopped).toBeInstanceOf(CategorizeError);
    expect((stopped as CategorizeError).kind).toBe('permanent');
  });

  test('one 429 waits and retries the transaction instead of the chunk', async () => {
    const fake = fakeProviders((request, call) => {
      if (call === 1) throw new AiProviderError('rate_limited', 'slow down', 429, 5);
      return answer([{ category_id: a.food, confidence: 0.9 }]);
    });
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, suggested: 1 });
    expect(fake.calls).toHaveLength(2);
    expect((await suggestionsOf(txn)).length).toBe(1);
  });

  test('a second 429 is thrown so Temporal waits the provider delay outside the activity', async () => {
    const fake = fakeProviders(() => Promise.reject(new AiProviderError('rate_limited', 'slow down', 429, 5)));
    setProviders(fake.table);
    await uncategorized(a);

    const error = await run(a).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect((error as CategorizeError).kind).toBe('rate_limited');
    expect(fake.calls).toHaveLength(2);
  });

  for (const kind of ['auth', 'transient'] as const) {
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

describe.skipIf(!dbReady)('keyset walking, resume and accounting', () => {
  test('a new row at the top and a shrink mid-run cannot duplicate or skip candidates', async () => {
    const first = await uncategorized(a, '2026-11-03');
    const second = await uncategorized(a, '2026-11-02');
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);

    const prepared = await prepareRun(pool, a.budgetId, false);
    if (!('snapshot' in prepared)) throw new Error('expected a prepared window');
    expect(prepared.total).toBe(2);
    const snapshot = prepared.snapshot!;

    // First chunk: newest only.
    const head = await run(a, { snapshot, limit: 1, total: 2 });
    if (!('nextCursor' in head)) throw new Error('expected a chunk window');
    expect(head.examined).toBe(1);
    expect(head.nextCursor).toEqual({ date: '2026-11-03', id: first });

    // A connections sync inserts a newer row and an older one mid-run.
    const newer = await uncategorized(a, '2026-11-10');
    const older = await uncategorized(a, '2026-10-01');

    const tail = await run(a, { snapshot, cursor: head.nextCursor, limit: 1, total: 2 });
    if (!('nextCursor' in tail)) throw new Error('expected a chunk window');
    expect(tail.examined).toBe(1);
    expect(tail.nextCursor).toEqual({ date: '2026-11-02', id: second });

    expect((await suggestionsOf(first)).length).toBe(1);
    expect((await suggestionsOf(second)).length).toBe(1);
    expect(await suggestionsOf(newer)).toEqual([]);
    expect(await suggestionsOf(older)).toEqual([]);
  });

  test('a retried chunk resumes after its last finished transaction and keeps billed tokens', async () => {
    const first = await uncategorized(a, '2026-11-03');
    const second = await uncategorized(a, '2026-11-02');
    const third = await uncategorized(a, '2026-11-01');
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);

    const resume: ChunkProgress = {
      examined: 1,
      total: 3,
      cursor: { date: '2026-11-03', id: first },
      suggested: 0,
      rule: 0,
      empty: 0,
      skipped: 0,
      failed: 0,
      failedIds: [],
      inputTokens: 5,
      outputTokens: 2,
    };
    const result = await run(a, { force: true, limit: 2, total: 3, cursor: null, snapshot: MAX, resume });
    if (!('examined' in result)) throw new Error('expected a chunk window');
    // Only the two remaining rows were sent to the model; the first was not
    // paid for again and got no new row.
    expect(result.examined).toBe(3);
    expect(result.usage).toEqual({ input: 25, output: 12 });
    expect(await suggestionsOf(first)).toEqual([]);
    expect((await suggestionsOf(second)).length).toBe(1);
    expect((await suggestionsOf(third)).length).toBe(1);
  });

  test('a failed transaction still contributes the tokens it did spend', async () => {
    setProviders(
      fakeProviders((request, call) => {
        if (call === 1) return toolTurn('list_categories', {});
        throw new AiProviderError('timeout', 'slow');
      }).table,
    );
    await uncategorized(a);
    const result = await run(a);
    if (!('usage' in result)) throw new Error('expected a chunk window');
    // One tool turn (7 in / 3 out) was billed before the two timed-out
    // attempts; the transaction failed but the run's totals include it.
    expect(result).toMatchObject({ examined: 1, failed: 1, suggested: 0 });
    expect(result.usage).toEqual({ input: 7, output: 3 });
  });

  test('a normal re-run does not re-ask a transaction that already has suggestions', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }])).table);
    await uncategorized(a);
    await run(a);
    const prepared = await prepareRun(pool, a.budgetId, false);
    expect(prepared).toMatchObject({ total: 0, remaining: 0 });
    expect(await run(a)).toMatchObject({ examined: 0 });
    // An explicit re-classify asks again.
    expect(await run(a, { force: true })).toMatchObject({ examined: 1 });
  });

  test('a run-level failure keeps the failing transaction usage in the heartbeat', async () => {
    setProviders(
      fakeProviders((request, call) => {
        if (call === 1) return toolTurn('list_categories', {});
        throw new AiProviderError('auth', 'refused', 401);
      }).table,
    );
    await uncategorized(a);
    const snapshots: ChunkProgress[] = [];
    const error = await run(a, { onProgress: (progress) => snapshots.push({ ...progress }) }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CategorizeError);
    expect(snapshots.some((progress) => progress.inputTokens === 7 && progress.outputTokens === 3)).toBe(true);
  });
});

describe.skipIf(!dbReady)('run cap and prepare', () => {
  test('prepare caps the run and reports the remainder', async () => {
    for (const date of ['2026-11-03', '2026-11-02', '2026-11-01']) await uncategorized(a, date);
    const prepared = await prepareRun(pool, a.budgetId, false, 2);
    expect(prepared).toMatchObject({ total: 2, remaining: 1 });
    if ('snapshot' in prepared) expect(prepared.snapshot?.date).toBe('2026-11-03');
  });

  test('prepare with no candidates has no snapshot and no work', async () => {
    expect(await prepareRun(pool, a.budgetId, false)).toEqual({ total: 0, remaining: 0, snapshot: null });
  });

  test('prepare ends at once without a usable key and makes no provider call', async () => {
    const bare = await newBudget('run-bare');
    const fake = fakeProviders(() => answer([]));
    setProviders(fake.table);

    // The fresh owner has no ai_credentials and the shared key is not configured.
    expect(await prepareRun(pool, bare.budgetId, false)).toEqual({ problem: 'own_key_required' });
    expect(fake.calls).toHaveLength(0);
  });

  test('prepare reports a key saved without a model', async () => {
    const bare = await newBudget('run-no-model');
    await storeOwnKey(pool, bare.userId, 'openai', 'sk-test-no-model-0123456789', null);
    await uncategorized(bare);
    setProviders(fakeProviders(() => answer([])).table);

    expect(await prepareRun(pool, bare.budgetId, false)).toEqual({ problem: 'no_model' });
    expect(await run(bare)).toEqual({ problem: 'no_model' });
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

  test('no activity result or workflow-visible value contains the key', async () => {
    const fake = fakeProviders(() => answer([{ category_id: a.food, confidence: 0.9 }]));
    setProviders(fake.table);
    await uncategorized(a);

    const prepared = await prepareRun(pool, a.budgetId, false);
    const chunk = await run(a);
    // The fake did receive the key (proves it was resolved), but it never
    // appears in a result, and no request message carries it either.
    expect(fake.calls[0]!.apiKey).toBe(KEY);
    for (const value of [prepared, chunk]) expect(JSON.stringify(value)).not.toContain(KEY);
    for (const call of fake.calls) expect(JSON.stringify(call.request)).not.toContain(KEY);
  });
  test('an empty answer is recorded and not re-billed by a normal run', async () => {
    const fake = fakeProviders(() => answer([]));
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, empty: 1, failed: 0 });
    const attempt = await attemptOf(txn);
    expect(attempt).toMatchObject({ outcome: 'no_suggestion', error_kind: null, attempts: 1, model: 'fake-model' });

    // A normal run has nothing to do: the transaction was already classified.
    expect(await run(a)).toMatchObject({ examined: 0, empty: 0 });
    expect(fake.calls).toHaveLength(1);

    // An explicit re-classify (force) asks again without growing the counter.
    expect(await run(a, { force: true })).toMatchObject({ examined: 1, empty: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(await attemptOf(txn)).toMatchObject({ outcome: 'no_suggestion', attempts: 1 });
  });

  test('a no_suggestion row is re-asked once its memo (or payee) changes', async () => {
    const fake = fakeProviders(() => answer([]));
    setProviders(fake.table);
    const txn = await uncategorized(a, '2026-11-02', { memo: 'old memo' });
    await run(a);
    expect(fake.calls).toHaveLength(1);

    await pool.query('update public.transactions set memo = $2 where id = $1', [txn, 'new memo']);
    expect(await run(a)).toMatchObject({ examined: 1, empty: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(await attemptOf(txn)).toMatchObject({ outcome: 'no_suggestion', attempts: 2 });
  });

  test('a truncated answer is its own failure kind, recorded, and retried only after the backoff', async () => {
    const fake = fakeProviders(() => ({ ...answer([{ category_id: a.food, confidence: 0.9 }]), finishReason: 'length' }));
    setProviders(fake.table);
    const txn = await uncategorized(a);

    expect(await run(a)).toMatchObject({ examined: 1, failed: 1, suggested: 0 });
    expect(await attemptOf(txn)).toMatchObject({ outcome: 'failed', error_kind: 'truncated', attempts: 1 });

    // Still inside the failure backoff: not re-billed.
    expect(await run(a)).toMatchObject({ examined: 0, failed: 0 });
    expect(fake.calls).toHaveLength(1);

    // After the backoff it is retried, and the attempt counter grows.
    await pool.query(`update public.categorize_attempts set last_attempt_at = now() - interval '1 hour' where transaction_id = $1`, [txn]);
    expect(await run(a)).toMatchObject({ examined: 1, failed: 1 });
    expect(fake.calls).toHaveLength(2);
    expect(await attemptOf(txn)).toMatchObject({ outcome: 'failed', error_kind: 'truncated', attempts: 2 });

    // Out of attempts: only force asks again.
    await pool.query(
      `update public.categorize_attempts set attempts = 3, last_attempt_at = now() - interval '1 day' where transaction_id = $1`,
      [txn],
    );
    expect(await run(a)).toMatchObject({ examined: 0, failed: 0 });
    expect(fake.calls).toHaveLength(2);
    expect(await run(a, { force: true })).toMatchObject({ examined: 1, failed: 1 });
    expect(fake.calls).toHaveLength(3);
    expect(await attemptOf(txn)).toMatchObject({ attempts: 1 });
  });

  test('the run cap walks the backlog across runs instead of re-billing the same rows', async () => {
    const fake = fakeProviders((_request, call) => {
      if (call === 1) return answer([]); // newest: classified, no suggestion
      if (call === 2) return { ...answer([{ category_id: a.food, confidence: 0.5 }]), finishReason: 'max_tokens' }; // middle: failed
      return answer([{ category_id: a.food, confidence: 0.9 }]); // oldest: suggested
    });
    setProviders(fake.table);
    const newest = await uncategorized(a, '2026-11-03');
    const middle = await uncategorized(a, '2026-11-02');
    const oldest = await uncategorized(a, '2026-11-01');

    expect(await run(a, { limit: 2 })).toMatchObject({ examined: 2, empty: 1, failed: 1, suggested: 0 });
    // The next run must reach the third row, not pay for the first two again.
    expect(await run(a, { limit: 2 })).toMatchObject({ examined: 1, suggested: 1, empty: 0, failed: 0 });
    expect(fake.calls).toHaveLength(3);
    expect((await suggestionsOf(oldest)).map((row) => row.category_id)).toEqual([a.food]);
    expect(await attemptOf(newest)).toMatchObject({ outcome: 'no_suggestion' });
    expect(await attemptOf(middle)).toMatchObject({ outcome: 'failed', error_kind: 'truncated' });
    expect(await attemptOf(oldest)).toMatchObject({ outcome: 'suggested' });
  });

  test('three consecutive request failures stop the run with the systematic failure', async () => {
    setProviders(fakeProviders(() => {
      throw new AiProviderError('permanent', 'bad request', 400);
    }).table);
    await uncategorized(a, '2026-11-03');
    await uncategorized(a, '2026-11-02');
    await uncategorized(a, '2026-11-01');

    await expect(run(a)).rejects.toMatchObject({ kind: 'systematic' });
  });

});
