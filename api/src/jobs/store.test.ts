import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { createJobContext } from './log';
import { appendLog, cancelQueued, closeRun, enqueueJob, getLogs, markAttemptStart, markRunStarted, MAX_LOG_LINES_PER_ATTEMPT, purgeOld } from './store';

const TYPE = 'jobs_store_test';

describe.skipIf(!dbReady)('jobs store (db)', () => {
  beforeEach(async () => {
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
  });
  afterAll(async () => {
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
  });

  test('enqueue creates a queued run; a second request for the same subject joins it', async () => {
    const a = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'x', input: { n: 1 }, instanceId: 't' });
    const b = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'x', input: { n: 2 }, instanceId: 't' });
    expect(a.created).toBe(true);
    expect(a.run.status).toBe('queued');
    expect(b.created).toBe(false);
    expect(b.run.id).toBe(a.run.id);
    const other = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'y', instanceId: 't' });
    expect(other.created).toBe(true);
  });

  test('concurrent enqueues coalesce to a single active run', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enqueueJob(pool, { jobType: TYPE, subjectKey: 'race', instanceId: 't' })),
    );
    expect(new Set(results.map((r) => r.run.id)).size).toBe(1);
    expect(results.filter((r) => r.created).length).toBe(1);
  });

  test('a finished run no longer blocks a new one; running still coalesces', async () => {
    const a = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'z', instanceId: 't' });
    await markRunStarted(pool, a.run.id);
    expect((await enqueueJob(pool, { jobType: TYPE, subjectKey: 'z', instanceId: 't' })).run.id).toBe(a.run.id);
    await closeRun(pool, a.run.id, { status: 'succeeded', result: { ok: 1 } });
    const c = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'z', instanceId: 't' });
    expect(c.created).toBe(true);
    expect(c.run.id).not.toBe(a.run.id);
  });

  test('enqueue inside a caller transaction is rolled back with it (outbox)', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await enqueueJob(client, { jobType: TYPE, subjectKey: 'tx', instanceId: 't' });
      await client.query('rollback');
    } finally {
      client.release();
    }
    const { rowCount } = await pool.query('select 1 from jobs.job_runs where job_type = $1', [TYPE]);
    expect(rowCount).toBe(0);
  });

  test('cancelQueued only affects queued runs; closeRun never overrides a cancelled run', async () => {
    const a = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'c', instanceId: 't' });
    expect((await cancelQueued(pool, a.run.id))?.status).toBe('cancelled');
    expect(await cancelQueued(pool, a.run.id)).toBeNull();
    await closeRun(pool, a.run.id, { status: 'succeeded' });
    expect((await pool.query('select status from jobs.job_runs where id = $1', [a.run.id])).rows[0].status).toBe('cancelled');
    expect(await markRunStarted(pool, a.run.id)).toBe(false);
  });

  test('ctx.log caps stored lines per attempt and still mirrors every line to stdout', async () => {
    const a = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'log', instanceId: 't' });
    await markAttemptStart(pool, a.run.id, 1, 'w');
    const out: string[] = [];
    const ctx = createJobContext(pool, { runId: a.run.id, attemptNo: 1 }, (l) => out.push(l));
    for (let i = 0; i < MAX_LOG_LINES_PER_ATTEMPT + 25; i++) await ctx.log('info', `line ${i}`, { i });
    const stored = await getLogs(pool, a.run.id);
    expect(stored.length).toBe(MAX_LOG_LINES_PER_ATTEMPT);
    expect(out.length).toBe(MAX_LOG_LINES_PER_ATTEMPT + 25);
    // a fresh ctx (activity re-run) seeds from the DB and stays capped
    const again = createJobContext(pool, { runId: a.run.id, attemptNo: 1 }, () => undefined);
    await again.log('info', 'extra');
    expect((await getLogs(pool, a.run.id)).length).toBe(MAX_LOG_LINES_PER_ATTEMPT);
    // another attempt has its own budget
    await markAttemptStart(pool, a.run.id, 2, 'w');
    expect(await appendLog(pool, { runId: a.run.id, attemptNo: 2, level: 'info', message: 'ok' })).toBe(true);
  });

  test('retention purges old logs and old finished runs only', async () => {
    const old = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'old', instanceId: 't' });
    await closeRun(pool, old.run.id, { status: 'failed' });
    await pool.query("update jobs.job_runs set finished_at = now() - interval '200 days' where id = $1", [old.run.id]);
    const recent = await enqueueJob(pool, { jobType: TYPE, subjectKey: 'recent', instanceId: 't' });
    await markAttemptStart(pool, recent.run.id, 1, 'w');
    await appendLog(pool, { runId: recent.run.id, attemptNo: 1, level: 'info', message: 'old line' });
    await pool.query("update jobs.job_logs set ts = now() - interval '40 days' where run_id = $1", [recent.run.id]);
    await purgeOld(pool, 30, 180);
    expect((await pool.query('select 1 from jobs.job_runs where id = $1', [old.run.id])).rowCount).toBe(0);
    expect((await pool.query('select 1 from jobs.job_runs where id = $1', [recent.run.id])).rowCount).toBe(1);
    expect((await getLogs(pool, recent.run.id)).length).toBe(0);
  });
});
