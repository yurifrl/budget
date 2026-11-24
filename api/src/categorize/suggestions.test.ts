/**
 * The read path budget-edxg consumes: pending suggestions at/above a
 * threshold, joined with the transaction/category/account the page shows, and
 * scoped to one budget. Also the run start/status helpers (coalescing and the
 * ledger read).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { setProviders, storeOwnKey } from '../ai';
import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { dbReady } from '../core/test-gate';
import { runChunk } from './chunk';
import { answer, fakeProviders } from './fake-provider';
import { categorizeRunStatus, startCategorizeRun } from './job';
import { listSuggestions } from './store';
import { cleanupFixtures, newBudget, newTransaction, type BudgetFixture } from './test-fixtures';

const KEY = 'sk-test-read-0123456789abcdef';
let fixture: BudgetFixture;

beforeEach(async () => {
  if (!dbReady) return;
  await cleanupFixtures();
  fixture = await newBudget('read-a');
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
  await storeOwnKey(pool, fixture.userId, 'openai', KEY, 'fake-model');
});

afterAll(async () => {
  if (!dbReady) return;
  setProviders(null);
  configureSecretBox(null);
  await cleanupFixtures();
});

const options = { minConfidence: 0, limit: 50, offset: 0 };

describe.skipIf(!dbReady)('reading category suggestions', () => {
  test('returns pending suggestions at/above the threshold with the joined page fields', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8, reason: 'market' }])).table);
    const txn = await newTransaction({
      budgetId: fixture.budgetId,
      accountId: fixture.accountId,
      date: '2026-11-01',
      amount: -4200,
      memo: 'weekly shop',
      importPayeeName: 'MERCADO',
    });
    await runChunk(pool, { budgetId: fixture.budgetId, offset: 0, limit: 10, total: 1 });

    const all = await listSuggestions(pool, fixture.budgetId, options);
    expect(all.total).toBe(1);
    expect(all.rows[0]).toMatchObject({
      transaction_id: txn,
      rank: 1,
      category_id: fixture.food,
      category_name: 'Food',
      group_name: 'Everyday',
      confidence: 0.8,
      reason: 'market',
      source: 'ai',
      provider: 'openai',
      model: 'fake-model',
      status: 'pending',
      date: '2026-11-01',
      amount_milliunits: -4200,
      payee: 'MERCADO',
      account_name: 'Checking',
      memo: 'weekly shop',
    });

    expect((await listSuggestions(pool, fixture.budgetId, { ...options, minConfidence: 0.85 })).total).toBe(0);
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, transactionId: txn })).total).toBe(1);
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, transactionId: crypto.randomUUID() })).total).toBe(0);
  });

  test('another budget never sees these suggestions', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-02', amount: -100 });
    await runChunk(pool, { budgetId: fixture.budgetId, offset: 0, limit: 10, total: 1 });
    const other = await newBudget('read-b');
    expect(await listSuggestions(pool, other.budgetId, options)).toEqual({ rows: [], total: 0 });
  });

  test('decided rows leave the pending queue; a categorized transaction drops out', async () => {
    setProviders(fakeProviders(() => answer([{ category_id: fixture.food, confidence: 0.8 }])).table);
    const decided = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-03', amount: -200 });
    const categorized = await newTransaction({ budgetId: fixture.budgetId, accountId: fixture.accountId, date: '2026-11-04', amount: -300 });
    await runChunk(pool, { budgetId: fixture.budgetId, offset: 0, limit: 10, total: 2 });

    await pool.query(`update public.category_suggestions set status = 'accepted' where transaction_id = $1`, [decided]);
    await pool.query('update public.transactions set category_id = $2 where id = $1', [categorized, fixture.food]);

    expect(await listSuggestions(pool, fixture.budgetId, options)).toEqual({ rows: [], total: 0 });
    expect((await listSuggestions(pool, fixture.budgetId, { ...options, status: 'accepted' })).total).toBe(1);
  });
});

describe.skipIf(!dbReady)('starting and reading a run', () => {
  test('concurrent starts join one run per budget and the status follows the ledger', async () => {
    const first = await startCategorizeRun(pool, { budgetId: fixture.budgetId, ownerUserId: fixture.userId, requestedBy: fixture.userId });
    const second = await startCategorizeRun(pool, { budgetId: fixture.budgetId, ownerUserId: fixture.userId, requestedBy: fixture.userId });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.run.id).toBe(first.run.id);

    const other = await newBudget('run-other');
    const elsewhere = await startCategorizeRun(pool, { budgetId: other.budgetId, ownerUserId: other.userId, requestedBy: other.userId });
    expect(elsewhere.run.id).not.toBe(first.run.id);

    const active = await categorizeRunStatus(pool, fixture.budgetId);
    expect(active.active?.id).toBe(first.run.id);
    expect(active.lastFinished).toBeNull();

    await pool.query(
      `update jobs.job_runs set status = 'succeeded', finished_at = now(), result = $2::jsonb where id = $1`,
      [first.run.id, JSON.stringify({ total: 0, done: 0 })],
    );
    const after = await categorizeRunStatus(pool, fixture.budgetId);
    expect(after.active).toBeNull();
    expect(after.lastFinished?.id).toBe(first.run.id);
  });
});
