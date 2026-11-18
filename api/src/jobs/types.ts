/** Shared jobs types. Pure: no SDK, no pg client construction. */
import type { Pool, PoolClient } from 'pg';

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];
export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running'];

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Anything that can run a query: the pool, or a client inside a caller's transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface JobRun {
  id: string;
  job_type: string;
  subject_key: string;
  tenant_id: string | null;
  instance_id: string;
  status: JobStatus;
  input: unknown;
  result: unknown;
  error_message: string | null;
  user_message: string | null;
  attempts: number;
  temporal_workflow_id: string | null;
  temporal_run_id: string | null;
  retry_of: string | null;
  requested_by: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export interface JobAttempt {
  run_id: string;
  attempt_no: number;
  worker_id: string | null;
  started_at: string;
  finished_at: string | null;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  error_message: string | null;
  error_stack: string | null;
  error_code: string | null;
}

export interface JobLog {
  id: number;
  run_id: string;
  attempt_no: number;
  ts: string;
  level: LogLevel;
  message: string;
  fields: Record<string, unknown> | null;
}

/** Payload every job workflow receives as its single argument. */
export interface JobWorkflowArgs {
  runId: string;
  jobType: string;
  subjectKey: string;
  tenantId: string | null;
  input: unknown;
}

export interface StartWorkflowRequest {
  workflow: string;
  taskQueue: string;
  workflowId: string;
  args: JobWorkflowArgs;
}

/** Port the relay uses to hand a run to the executor. Idempotent on workflowId. */
export interface WorkflowStarter {
  start(req: StartWorkflowRequest): Promise<{ workflowId: string; runId: string }>;
}

export interface TemporalHealth {
  up: boolean;
  /** Why the scheduler is considered down; absent when up. */
  reason?: string;
  checked_at: string;
}

/** What the API process holds: health + cancel only. */
export interface TemporalPort {
  health(): Promise<TemporalHealth>;
  /** Request cancellation of a running workflow. Rejects when unreachable. */
  cancel(workflowId: string): Promise<void>;
}
