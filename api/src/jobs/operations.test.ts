/** Jobs operation catalog + admin guard + handler behaviour. DB-gated. */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { Hono } from 'hono';

import { ApiError, createApiClient } from '../core/client';
import { pool } from '../core/db';
import { describeOperationCatalog } from '../core/operation-catalog-test';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import jobsApp, { operations } from './index';
import { configureJobs } from './runtime';
import { closeRun, enqueueJob, markAttemptStart, markRunStarted } from './store';
import type { TemporalPort } from './types';

describeOperationCatalog('jobs', operations, jobsApp, '/jobs');

describe('jobs exposure', () => {
  test('API + CLI only (never MCP); cancel is destructive; health/list/get are reads', () => {
    for (const { contract } of operations) {
      expect(contract.expose, contract.name).toEqual({ api: true, cli: true, mcp: false });
    }
    const kind = (n: string) => operations.find((o) => o.contract.name === n)!.contract.kind;
    expect(kind('jobs_cancel_run')).toBe('destructive');
    expect(kind('jobs_retry_run')).toBe('write');
    expect(['jobs_list_runs', 'jobs_get_run', 'jobs_health'].map(kind)).toEqual(['read', 'read', 'read']);
  });
});

const user = (role: 'admin' | 'user'): IdentityUser => ({
  id: crypto.randomUUID(),
  email: `jobs-${role}@syscd.local`,
  googleSub: null,
  role,
  status: 'active',
});
let current: IdentityUser | undefined;
const app = new Hono();
app.onError(httpOnError);
app.use('*', (c, next) => {
  if (current) c.set('user', current);
  return next();
});
app.route('/jobs', jobsApp);
const client = createApiClient({ baseUrl: 'http://api.test', fetch: (req) => Promise.resolve(app.fetch(req)) });
const op = (name: string) => operations.find((o) => o.contract.name === name)!.contract;

const cancelled: string[] = [];
let temporalUp = true;
const fakeTemporal: TemporalPort = {
  health: async () => ({ up: temporalUp, reason: temporalUp ? undefined : 'ECONNREFUSED', checked_at: new Date().toISOString() }),
  cancel: async (id) => {
    if (!temporalUp) throw new Error('ECONNREFUSED');
    cancelled.push(id);
  },
};

const TYPE = 'jobs_ops_test';

describe('admin guard (no db needed)', () => {
  test('anonymous 401, non-admin 403 on every operation', async () => {
    const id = crypto.randomUUID();
    for (const { contract } of operations) {
      current = undefined;
      const anon = await client.call(contract, { id }).catch((e: unknown) => e);
      expect((anon as ApiError).status, contract.name).toBe(401);
      current = user('user');
      const normal = await client.call(contract, { id }).catch((e: unknown) => e);
      expect((normal as ApiError).status, contract.name).toBe(403);
    }
  });
});

describe.skipIf(!dbReady)('jobs admin operations (db)', () => {
  beforeEach(async () => {
    configureJobs({ temporal: fakeTemporal, instanceId: 'ops-test' });
    temporalUp = true;
    cancelled.length = 0;
    current = user('admin');
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
  });
  afterAll(async () => {
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
  });

  test('list filters by status/job_type and pages; get returns attempts and logs', async () => {
    const a = (await enqueueJob(pool, { jobType: TYPE, subjectKey: '1' })).run;
    await markRunStarted(pool, a.id);
    await markAttemptStart(pool, a.id, 1, 'w1');
    await closeRun(pool, a.id, { status: 'failed', errorMessage: 'boom' });
    await enqueueJob(pool, { jobType: TYPE, subjectKey: '2' });
    const failed = (await client.call(op('jobs_list_runs'), { job_type: TYPE, status: 'failed' })) as { runs: { id: string }[]; total: number };
    expect(failed.runs.map((r) => r.id)).toEqual([a.id]);
    const all = (await client.call(op('jobs_list_runs'), { job_type: TYPE, limit: 1 })) as { runs: unknown[]; total: number };
    expect(all.total).toBe(2);
    expect(all.runs.length).toBe(1);
    const got = (await client.call(op('jobs_get_run'), { id: a.id })) as { run: { error_message: string }; attempts: { worker_id: string }[]; logs: unknown[] };
    expect(got.run.error_message).toBe('boom');
    expect(got.attempts[0]!.worker_id).toBe('w1');
    const missing = await client.call(op('jobs_get_run'), { id: crypto.randomUUID() }).catch((e: unknown) => e);
    expect((missing as ApiError).status).toBe(404);
  });

  test('retry creates a new linked run for failed/cancelled runs only', async () => {
    const a = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'r', input: { x: 1 } })).run;
    const early = await client.call(op('jobs_retry_run'), { id: a.id }).catch((e: unknown) => e);
    expect((early as ApiError).status).toBe(409);
    await closeRun(pool, a.id, { status: 'failed', errorMessage: 'nope' });
    const res = (await client.call(op('jobs_retry_run'), { id: a.id })) as { run: { id: string; retry_of: string; status: string; input: unknown }; created: boolean };
    expect(res.created).toBe(true);
    expect(res.run.id).not.toBe(a.id);
    expect(res.run.retry_of).toBe(a.id);
    expect(res.run.status).toBe('queued');
    expect(res.run.input).toEqual({ x: 1 });
    // old run is kept as history; a second retry joins the active one
    const again = (await client.call(op('jobs_retry_run'), { id: a.id })) as { run: { id: string }; created: boolean };
    expect(again.created).toBe(false);
    expect(again.run.id).toBe(res.run.id);
  });

  test('cancel: queued -> cancelled in the ledger; running -> Temporal cancel; down -> 503', async () => {
    const q = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'q' })).run;
    const done = (await client.call(op('jobs_cancel_run'), { id: q.id })) as { status: string };
    expect(done.status).toBe('cancelled');
    expect(cancelled.length).toBe(0);
    expect(((await client.call(op('jobs_cancel_run'), { id: q.id }).catch((e: unknown) => e)) as ApiError).status).toBe(409);

    const r = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'run' })).run;
    await pool.query("update jobs.job_runs set temporal_workflow_id = id::text, status = 'running' where id = $1", [r.id]);
    temporalUp = false;
    expect(((await client.call(op('jobs_cancel_run'), { id: r.id }).catch((e: unknown) => e)) as ApiError).status).toBe(503);
    temporalUp = true;
    await client.call(op('jobs_cancel_run'), { id: r.id });
    expect(cancelled).toEqual([r.id]);
  });

  test('health reports temporal up/down with reason and the queued count', async () => {
    await enqueueJob(pool, { jobType: TYPE, subjectKey: 'h' });
    const up = (await client.call(op('jobs_health'))) as { temporal: { up: boolean }; queued: number };
    expect(up.temporal.up).toBe(true);
    expect(up.queued).toBeGreaterThanOrEqual(1);
    temporalUp = false;
    const down = (await client.call(op('jobs_health'))) as { temporal: { up: boolean; reason: string } };
    expect(down.temporal).toMatchObject({ up: false, reason: 'ECONNREFUSED' });
  });
});
