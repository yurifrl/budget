import { z } from '../../zod';

import { defineOperation, EXPOSE_NO_MCP } from '../../operation-contract';
import { JOB_STATUSES } from './statuses';

/** Admin-only; surfaced on the API and CLI, never MCP. */
const ADMIN_EXPOSE = EXPOSE_NO_MCP;

const runId = z.string().uuid();

export const jobsListRuns = defineOperation({
  name: 'jobs_list_runs',
  description:
    'Admin: list background job runs, newest first. Filter by instance_id, tenant_id (user id), job_type and status (queued, running, succeeded, failed, cancelled). Returns { runs, total }.',
  input: z.object({
    instance_id: z.string().min(1).optional(),
    tenant_id: z.string().uuid().optional(),
    job_type: z.string().min(1).optional(),
    status: z.enum(JOB_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  }),
  method: 'GET',
  path: '/jobs/runs',
  kind: 'read',
  expose: ADMIN_EXPOSE,
});

export const jobsGetRun = defineOperation({
  name: 'jobs_get_run',
  description: 'Admin: one background job run with its attempts (errors, stacks, worker) and captured log lines.',
  input: z.object({ id: runId }),
  method: 'GET',
  path: '/jobs/runs/:id',
  kind: 'read',
  expose: ADMIN_EXPOSE,
});

export const jobsRetryRun = defineOperation({
  name: 'jobs_retry_run',
  description:
    'Admin: retry a failed or cancelled run. Enqueues a NEW run (linked via retry_of) for the same job type, subject and input; joins the active run when one already exists. Returns { run, created }.',
  input: z.object({ id: runId }),
  method: 'POST',
  path: '/jobs/runs/:id/retry',
  kind: 'write',
  expose: ADMIN_EXPOSE,
});

export const jobsCancelRun = defineOperation({
  name: 'jobs_cancel_run',
  description:
    'Admin: cancel a queued or running job run. A queued run is cancelled in the ledger immediately; a running run gets a Temporal cancel request and closes as cancelled when the worker acknowledges it.',
  input: z.object({ id: runId }),
  method: 'POST',
  path: '/jobs/runs/:id/cancel',
  kind: 'destructive',
  expose: ADMIN_EXPOSE,
});

export const jobsHealth = defineOperation({
  name: 'jobs_health',
  description: 'Admin: scheduler health. Reports whether Temporal is reachable (with the reason when down), the queued run count and the Temporal UI url.',
  input: z.object({}),
  method: 'GET',
  path: '/jobs/health',
  kind: 'read',
  expose: ADMIN_EXPOSE,
});
