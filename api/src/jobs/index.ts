/**
 * Jobs feature barrel: ledger store + enqueue helper, job-type registry, relay,
 * the admin router (mounted at /jobs post-gate) and its operation catalog.
 * Temporal SDK code lives in temporal.ts / activities.ts / worker-host.ts /
 * workflows/ only. The barrel exports just the client (API health/cancel);
 * worker.ts deep-imports activities + worker-host so the API never loads the
 * native worker bridge.
 */
import type { AnyOperation } from '../core/operation';

import jobs, { operations as jobsOps } from './routes/jobs';
import { jobsRuntime } from './runtime';

export const operations: readonly AnyOperation[] = [...jobsOps];

export default jobs;
export { enqueueJob } from './store';
export type { EnqueueParams } from './store';
export { registerJobType } from './registry';
export { configureJobs } from './runtime';
export { createJobContext } from './log';
export type { JobContext } from './log';
export { startRelay, relayOnce } from './relay';
export { createTemporalClient } from './temporal';
export { hasOtherActiveRun, runsForSubjects } from './store';
export type { JobRun, Queryable } from './types';
/** Cached scheduler (Temporal) health ping — never throws. */
export async function schedulerHealth(): Promise<{ up: boolean; reason?: string }> {
  return jobsRuntime().temporal.health();
}
