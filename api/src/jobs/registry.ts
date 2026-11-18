/**
 * Job-type registry: features register {jobType, workflow, taskQueue?} so the
 * relay knows which Temporal workflow executes a run. The workflow function
 * itself must be exported from server/jobs/workflows/index.ts (the worker
 * bundles that single file).
 */
export interface JobTypeDef {
  jobType: string;
  /** Exported workflow function name in server/jobs/workflows/index.ts. */
  workflow: string;
  /** Overrides the worker's default task queue. */
  taskQueue?: string;
}

const defs = new Map<string, JobTypeDef>();

export function registerJobType(def: JobTypeDef): void {
  const existing = defs.get(def.jobType);
  if (existing && (existing.workflow !== def.workflow || existing.taskQueue !== def.taskQueue)) {
    throw new Error(`job type ${def.jobType} already registered with a different definition`);
  }
  defs.set(def.jobType, def);
}

export function getJobType(jobType: string): JobTypeDef | undefined {
  return defs.get(jobType);
}

export function listJobTypes(): JobTypeDef[] {
  return [...defs.values()];
}

/** Trivial built-in job used for the end-to-end demo and smoke tests. */
export const NOOP_JOB_TYPE = 'jobs_noop';
registerJobType({ jobType: NOOP_JOB_TYPE, workflow: 'jobsNoop' });
