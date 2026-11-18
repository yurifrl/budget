/**
 * Admin jobs operations (guarded by requireAdmin at mount): list/get/retry/
 * cancel runs of the ledger and report scheduler health.
 */
import { Hono } from 'hono';

import { pool } from '../../core/db';
import { implement, mountOperations } from '../../core/operation';
import { HttpError } from '../../core/validate';
import { requireAdmin } from '../../user';
import { jobsCancelRun, jobsGetRun, jobsHealth, jobsListRuns, jobsRetryRun } from '@shared/contracts/jobs/jobs';
import { jobsRuntime } from '../runtime';
import { cancelQueued, countQueued, enqueueJob, getAttempts, getLogs, getRun, listRuns } from '../store';

export const operations = [
  implement(jobsListRuns, async (_c, i) =>
    listRuns(pool, {
      instanceId: i.instance_id,
      tenantId: i.tenant_id,
      jobType: i.job_type,
      status: i.status,
      limit: i.limit,
      offset: i.offset,
    }),
  ),

  implement(jobsGetRun, async (_c, { id }) => {
    const run = await getRun(pool, id);
    if (!run) throw new HttpError(404, 'run not found');
    const [attempts, logs] = await Promise.all([getAttempts(pool, id), getLogs(pool, id)]);
    return { run, attempts, logs };
  }),

  implement(jobsRetryRun, async (c, { id }) => {
    const old = await getRun(pool, id);
    if (!old) throw new HttpError(404, 'run not found');
    if (old.status !== 'failed' && old.status !== 'cancelled') {
      throw new HttpError(409, `only failed or cancelled runs can be retried (run is ${old.status})`);
    }
    return enqueueJob(pool, {
      jobType: old.job_type,
      subjectKey: old.subject_key,
      tenantId: old.tenant_id,
      input: old.input,
      instanceId: old.instance_id,
      retryOf: old.id,
      requestedBy: `admin:${c.get('user')?.id ?? 'unknown'}`,
    });
  }),

  implement(jobsCancelRun, async (_c, { id }) => {
    const run = await getRun(pool, id);
    if (!run) throw new HttpError(404, 'run not found');
    if (run.status !== 'queued' && run.status !== 'running') {
      throw new HttpError(409, `run already ${run.status}`);
    }
    if (run.status === 'queued') {
      const cancelled = await cancelQueued(pool, id);
      if (cancelled) {
        // The relay may have handed it off already: stop the workflow too (best effort).
        if (cancelled.temporal_workflow_id) await jobsRuntime().temporal.cancel(cancelled.temporal_workflow_id).catch(() => undefined);
        return cancelled;
      }
      // Raced with the worker marking it running; fall through to a Temporal cancel.
    }
    const fresh = (await getRun(pool, id))!;
    if (fresh.status !== 'running' && fresh.status !== 'queued') return fresh;
    if (!fresh.temporal_workflow_id) throw new HttpError(409, 'run has no workflow to cancel yet');
    try {
      await jobsRuntime().temporal.cancel(fresh.temporal_workflow_id);
    } catch (e) {
      throw new HttpError(503, `scheduler unreachable, cancel not delivered: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { ...fresh, cancel_requested: true };
  }),

  implement(jobsHealth, async () => {
    const rt = jobsRuntime();
    const [temporal, queued] = await Promise.all([rt.temporal.health(), countQueued(pool)]);
    return { temporal, queued, instance_id: rt.instanceId, ui_url: rt.uiUrl };
  }),
];

/** Relative to its mount point: server/app.ts mounts this at `/jobs`. */
export default mountOperations(new Hono(), operations, { basePath: '/jobs', use: [requireAdmin] });
