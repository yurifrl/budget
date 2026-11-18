import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { registerJobType } from './registry';
import { relayOnce } from './relay';
import { enqueueJob } from './store';
import type { StartWorkflowRequest, WorkflowStarter } from './types';

const TYPE = 'jobs_relay_test';
const INSTANCE = 'relay-test';
registerJobType({ jobType: TYPE, workflow: 'relayTestWorkflow' });

const status = async (id: string) =>
  (await pool.query('select status, temporal_workflow_id, error_message from jobs.job_runs where id = $1', [id])).rows[0];

describe.skipIf(!dbReady)('jobs relay (db, fake starter)', () => {
  beforeEach(async () => {
    await pool.query('delete from jobs.job_runs where job_type in ($1, $2)', [TYPE, 'jobs_unregistered_test']);
  });
  afterAll(async () => {
    await pool.query('delete from jobs.job_runs where job_type in ($1, $2)', [TYPE, 'jobs_unregistered_test']);
  });

  const deps = (starter: WorkflowStarter) => ({ pool, starter, instanceId: INSTANCE, defaultTaskQueue: 'q' });

  test('Temporal down: rows stay queued, unhandled, and the pass reports the error', async () => {
    const run = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'a', instanceId: INSTANCE })).run;
    const down: WorkflowStarter = {
      start: async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:7233');
      },
    };
    const res = await relayOnce(deps(down));
    expect(res.started).toBe(0);
    expect(res.error).toContain('ECONNREFUSED');
    const row = await status(run.id);
    expect(row.status).toBe('queued');
    expect(row.temporal_workflow_id).toBeNull();
  });

  test('recovery: the same row is started once Temporal is back, with workflowId = run id', async () => {
    const run = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'b', input: { k: 1 }, instanceId: INSTANCE })).run;
    const seen: StartWorkflowRequest[] = [];
    const up: WorkflowStarter = {
      start: async (req) => {
        seen.push(req);
        return { workflowId: req.workflowId, runId: 'temporal-run-1' };
      },
    };
    const res = await relayOnce(deps(up));
    expect(res).toEqual({ started: 1, error: null });
    expect(seen[0]!.workflowId).toBe(run.id);
    expect(seen[0]!.workflow).toBe('relayTestWorkflow');
    expect(seen[0]!.taskQueue).toBe('q');
    expect(seen[0]!.args.input).toEqual({ k: 1 });
    expect((await status(run.id)).temporal_workflow_id).toBe(run.id);
    // handed-off rows are not started again
    expect((await relayOnce(deps(up))).started).toBe(0);
    expect(seen.length).toBe(1);
  });

  test('cancelled queued runs are skipped; other instances are left alone', async () => {
    const mine = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'c', instanceId: INSTANCE })).run;
    await pool.query("update jobs.job_runs set status = 'cancelled' where id = $1", [mine.id]);
    await enqueueJob(pool, { jobType: TYPE, subjectKey: 'd', instanceId: 'someone-else' });
    let calls = 0;
    const starter: WorkflowStarter = {
      start: async (r) => {
        calls++;
        return { workflowId: r.workflowId, runId: 'r' };
      },
    };
    expect((await relayOnce(deps(starter))).started).toBe(0);
    expect(calls).toBe(0);
  });

  test('unknown job type fails the run instead of blocking the queue', async () => {
    const bad = (await enqueueJob(pool, { jobType: 'jobs_unregistered_test', subjectKey: 'e', instanceId: INSTANCE })).run;
    const starter: WorkflowStarter = { start: async (r) => ({ workflowId: r.workflowId, runId: 'r' }) };
    await relayOnce(deps(starter));
    const row = await status(bad.id);
    expect(row.status).toBe('failed');
    expect(row.error_message).toContain('unknown job type');
  });
});

describe.skipIf(!dbReady)('jobs relay timeout', () => {
  test('a starter that hangs is abandoned and the row stays queued', async () => {
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
    const run = (await enqueueJob(pool, { jobType: TYPE, subjectKey: 'hang', instanceId: INSTANCE })).run;
    const hang: WorkflowStarter = { start: () => new Promise(() => undefined) };
    const res = await relayOnce({ pool, starter: hang, instanceId: INSTANCE, defaultTaskQueue: 'q', startTimeoutMs: 100 });
    expect(res.error).toContain('timed out');
    expect((await status(run.id)).status).toBe('queued');
    await pool.query('delete from jobs.job_runs where job_type = $1', [TYPE]);
  });
});
