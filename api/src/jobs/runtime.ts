/**
 * Process-wide jobs configuration, set once by the entrypoints (which own env
 * access): the instance id stamped on new runs, the default task queue, and
 * the Temporal port the API handlers use for health/cancel.
 */
import type { TemporalHealth, TemporalPort } from './types';

interface Runtime {
  instanceId: string;
  taskQueue: string;
  temporal: TemporalPort;
  uiUrl: string | null;
}

const notConfigured: TemporalPort = {
  health: async (): Promise<TemporalHealth> => ({
    up: false,
    reason: 'temporal client not configured',
    checked_at: new Date().toISOString(),
  }),
  cancel: async () => {
    throw new Error('temporal client not configured');
  },
};

let runtime: Runtime = { instanceId: 'budget-local', taskQueue: 'budget-jobs', temporal: notConfigured, uiUrl: null };

export function configureJobs(patch: Partial<Runtime>): void {
  runtime = { ...runtime, ...patch };
}

export function jobsRuntime(): Readonly<Runtime> {
  return runtime;
}
