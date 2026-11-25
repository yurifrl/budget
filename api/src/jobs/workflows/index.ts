/**
 * Workflow bundle — bundled by the Temporal worker into its deterministic
 * sandbox. Imports ONLY @temporalio/workflow (+ types): no Bun APIs, no pg, no
 * other server code. Every job type's `workflow` name must be exported here.
 * Features contribute workflows from a pure `server/<feature>/workflows.ts`
 * re-exported below (documented seam, see AGENTS.md).
 */
import { proxyActivities, sleep } from '@temporalio/workflow';

import type { LedgerActivities } from '../activities';
import { ledger, runTracked, type JobArgs } from './tracked';

export { runTracked } from './tracked';
export { connectionsSync, connectionsSweep } from '../../connections/workflows';
export { categorizeRun } from '../../categorize/workflows';

const work = proxyActivities<LedgerActivities>({
  startToCloseTimeout: '5 minutes',
  heartbeatTimeout: '30 seconds',
  retry: { maximumAttempts: 3, initialInterval: '5 seconds', backoffCoefficient: 2 },
});

export async function jobsNoop(args: JobArgs): Promise<unknown> {
  return runTracked(args, () => work.jobsNoopWork({ runId: args.runId, input: args.input }));
}

export async function jobsRetention(): Promise<unknown> {
  await sleep(0);
  return ledger.retentionSweep();
}
