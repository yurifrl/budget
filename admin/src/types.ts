/** Response shapes of the jobs admin operations (mirrors server/jobs/types.ts; the contracts only carry inputs). */
export const STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export type Status = (typeof STATUSES)[number];

export interface JobRun {
  id: string;
  job_type: string;
  subject_key: string;
  tenant_id: string | null;
  instance_id: string;
  status: Status;
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
  status: string;
  error_message: string | null;
  error_stack: string | null;
  error_code: string | null;
}

export const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type Level = (typeof LEVELS)[number];

export interface JobLog {
  id: number;
  attempt_no: number;
  ts: string;
  level: Level;
  message: string;
  fields: Record<string, unknown> | null;
}

export interface RunDetail {
  run: JobRun;
  attempts: JobAttempt[];
  logs: JobLog[];
}

export interface JobsHealth {
  temporal: { up: boolean; reason?: string; checked_at: string };
  queued: number;
  instance_id: string;
  ui_url: string | null;
}
