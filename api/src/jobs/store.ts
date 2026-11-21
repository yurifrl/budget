/** Jobs ledger store: every SQL statement touching the `jobs` schema. */
import { ACTIVE_STATUSES } from './types';
import type { JobAttempt, JobLog, JobRun, JobStatus, LogLevel, Queryable } from './types';
import { jobsRuntime } from './runtime';
import { JOB_USER_MESSAGES } from './user-messages';

export const NOTIFY_CHANNEL = 'jobs_enqueued';
/** Max job_logs rows kept per attempt (extra lines are still mirrored to stdout). */
export const MAX_LOG_LINES_PER_ATTEMPT = 500;

export interface EnqueueParams {
  jobType: string;
  subjectKey: string;
  tenantId?: string | null;
  input?: unknown;
  requestedBy?: string | null;
  /** Defaults to the process instance id (configureJobs). */
  instanceId?: string;
  retryOf?: string | null;
}

/**
 * Insert a `queued` run, or join the active run for the same (job_type,
 * subject_key). Pass a client inside your own transaction to get the
 * transactional outbox: the row (and the NOTIFY, delivered on commit) only
 * exist if your domain work commits.
 */
export async function enqueueJob(db: Queryable, params: EnqueueParams): Promise<{ run: JobRun; created: boolean }> {
  const instanceId = params.instanceId ?? jobsRuntime().instanceId;
  for (let attempt = 0; attempt < 3; attempt++) {
    const inserted = await db.query<JobRun>(
      `insert into jobs.job_runs (job_type, subject_key, tenant_id, instance_id, input, requested_by, retry_of)
       values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (job_type, subject_key) where status in ('queued', 'running') do nothing
       returning *`,
      [
        params.jobType,
        params.subjectKey,
        params.tenantId ?? null,
        instanceId,
        JSON.stringify(params.input ?? {}),
        params.requestedBy ?? null,
        params.retryOf ?? null,
      ],
    );
    if (inserted.rows[0]) {
      await db.query('select pg_notify($1, $2)', [NOTIFY_CHANNEL, inserted.rows[0].id]);
      return { run: inserted.rows[0], created: true };
    }
    const active = await db.query<JobRun>(
      `select * from jobs.job_runs where job_type = $1 and subject_key = $2 and status = any($3) limit 1`,
      [params.jobType, params.subjectKey, ACTIVE_STATUSES],
    );
    // The active run may have finished between the conflict and the read; retry the insert.
    if (active.rows[0]) return { run: active.rows[0], created: false };
  }
  throw new Error(`enqueueJob: could not insert or join an active run for ${params.jobType}/${params.subjectKey}`);
}

export async function getRun(db: Queryable, id: string): Promise<JobRun | null> {
  const { rows } = await db.query<JobRun>('select * from jobs.job_runs where id = $1', [id]);
  return rows[0] ?? null;
}

export interface ListFilter {
  instanceId?: string;
  tenantId?: string;
  jobType?: string;
  status?: JobStatus;
  limit: number;
  offset: number;
}

export async function listRuns(db: Queryable, f: ListFilter): Promise<{ runs: JobRun[]; total: number }> {
  const where: string[] = [];
  const args: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    args.push(v);
    where.push(sql.replace('?', `$${args.length}`));
  };
  if (f.instanceId) add('instance_id = ?', f.instanceId);
  if (f.tenantId) add('tenant_id = ?', f.tenantId);
  if (f.jobType) add('job_type = ?', f.jobType);
  if (f.status) add('status = ?', f.status);
  const clause = where.length ? `where ${where.join(' and ')}` : '';
  const total = await db.query<{ n: number }>(`select count(*)::int as n from jobs.job_runs ${clause}`, args);
  const rows = await db.query<JobRun>(
    `select * from jobs.job_runs ${clause} order by created_at desc, id limit $${args.length + 1} offset $${args.length + 2}`,
    [...args, f.limit, f.offset],
  );
  return { runs: rows.rows, total: total.rows[0]?.n ?? 0 };
}

/** True when another queued/running run exists for the same (job_type, subject_key). */
export async function hasOtherActiveRun(db: Queryable, jobType: string, subjectKey: string, excludeRunId: string): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from jobs.job_runs where job_type = $1 and subject_key = $2 and status = any($3) and id <> $4 limit 1`,
    [jobType, subjectKey, ACTIVE_STATUSES, excludeRunId],
  );
  return rows.length > 0;
}

/**
 * For each subject key: its active run (queued/running, if any) and its most
 * recent finished run (if any). Feeds user-facing sync status.
 */
export async function runsForSubjects(
  db: Queryable,
  jobType: string,
  subjectKeys: string[],
): Promise<{ active: JobRun[]; lastFinished: JobRun[] }> {
  if (subjectKeys.length === 0) return { active: [], lastFinished: [] };
  const active = await db.query<JobRun>(
    `select * from jobs.job_runs where job_type = $1 and subject_key = any($2) and status = any($3) order by created_at desc`,
    [jobType, subjectKeys, ACTIVE_STATUSES],
  );
  const finished = await db.query<JobRun>(
    `select distinct on (subject_key) * from jobs.job_runs
      where job_type = $1 and subject_key = any($2) and status not in ('queued', 'running')
      order by subject_key, created_at desc`,
    [jobType, subjectKeys],
  );
  return { active: active.rows, lastFinished: finished.rows };
}

export async function getAttempts(db: Queryable, runId: string): Promise<JobAttempt[]> {
  const { rows } = await db.query<JobAttempt>(
    'select * from jobs.job_attempts where run_id = $1 order by attempt_no',
    [runId],
  );
  return rows;
}

export async function getLogs(db: Queryable, runId: string): Promise<JobLog[]> {
  const { rows } = await db.query<JobLog>(
    'select * from jobs.job_logs where run_id = $1 order by attempt_no, id',
    [runId],
  );
  return rows;
}

export async function countQueued(db: Queryable): Promise<number> {
  const { rows } = await db.query<{ n: number }>("select count(*)::int as n from jobs.job_runs where status = 'queued'");
  return rows[0]?.n ?? 0;
}

/** queued -> cancelled. Returns the updated row, or null when the run was not queued. */
export async function cancelQueued(db: Queryable, id: string): Promise<JobRun | null> {
  const { rows } = await db.query<JobRun>(
    `update jobs.job_runs
        set status = 'cancelled', finished_at = now(), user_message = coalesce(user_message, $2)
      where id = $1 and status = 'queued' returning *`,
    [id, JOB_USER_MESSAGES.cancelledBeforeStart],
  );
  return rows[0] ?? null;
}

// --- executor-side ledger writes (called by activities; all idempotent) ----

/** queued -> running. False when the run was cancelled/closed meanwhile. */
export async function markRunStarted(db: Queryable, runId: string, temporalRunId?: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update jobs.job_runs
        set status = 'running', started_at = coalesce(started_at, now()),
            temporal_run_id = coalesce($2, temporal_run_id)
      where id = $1 and status in ('queued', 'running')`,
    [runId, temporalRunId ?? null],
  );
  return (rowCount ?? 0) > 0;
}

/** Upsert an attempt as running; bumps job_runs.attempts to the highest attempt seen. */
export async function markAttemptStart(db: Queryable, runId: string, attemptNo: number, workerId: string): Promise<void> {
  await db.query(
    `insert into jobs.job_attempts (run_id, attempt_no, worker_id) values ($1, $2, $3)
     on conflict (run_id, attempt_no) do update set worker_id = excluded.worker_id, started_at = now(), finished_at = null, status = 'running'`,
    [runId, attemptNo, workerId],
  );
  await db.query('update jobs.job_runs set attempts = greatest(attempts, $2) where id = $1', [runId, attemptNo]);
}

export interface AttemptOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  errorMessage?: string | null;
  errorStack?: string | null;
  errorCode?: string | null;
}

export async function markAttemptFinish(db: Queryable, runId: string, attemptNo: number, o: AttemptOutcome): Promise<void> {
  await db.query(
    `update jobs.job_attempts
        set status = $3, finished_at = now(), error_message = $4, error_stack = $5, error_code = $6
      where run_id = $1 and attempt_no = $2`,
    [runId, attemptNo, o.status, o.errorMessage ?? null, o.errorStack ?? null, o.errorCode ?? null],
  );
}

export interface CloseOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  result?: unknown;
  errorMessage?: string | null;
  userMessage?: string | null;
}

/** Terminal write. Only active runs close (a cancelled queued run stays cancelled). */
export async function closeRun(db: Queryable, runId: string, o: CloseOutcome): Promise<void> {
  await db.query(
    `update jobs.job_runs
        set status = $2, finished_at = now(), result = $3::jsonb, error_message = $4, user_message = $5
      where id = $1 and status in ('queued', 'running')`,
    [runId, o.status, o.result === undefined ? null : JSON.stringify(o.result), o.errorMessage ?? null, o.userMessage ?? null],
  );
}

export async function appendLog(
  db: Queryable,
  l: { runId: string; attemptNo: number; level: LogLevel; message: string; fields?: Record<string, unknown> },
): Promise<boolean> {
  const { rowCount } = await db.query(
    `insert into jobs.job_logs (run_id, attempt_no, level, message, fields)
     select $1, $2, $3, $4, $5::jsonb
      where (select count(*) from jobs.job_logs where run_id = $1 and attempt_no = $2) < $6`,
    [l.runId, l.attemptNo, l.level, l.message, l.fields ? JSON.stringify(l.fields) : null, MAX_LOG_LINES_PER_ATTEMPT],
  );
  return (rowCount ?? 0) > 0;
}

export async function countAttemptLogs(db: Queryable, runId: string, attemptNo: number): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    'select count(*)::int as n from jobs.job_logs where run_id = $1 and attempt_no = $2',
    [runId, attemptNo],
  );
  return rows[0]?.n ?? 0;
}

/** Retention: logs older than logDays, finished runs older than runDays (cascades attempts/logs). */
export async function purgeOld(db: Queryable, logDays: number, runDays: number): Promise<{ logs: number; runs: number }> {
  const logs = await db.query(`delete from jobs.job_logs where ts < now() - make_interval(days => $1)`, [logDays]);
  const runs = await db.query(
    `delete from jobs.job_runs where status not in ('queued', 'running') and coalesce(finished_at, created_at) < now() - make_interval(days => $1)`,
    [runDays],
  );
  return { logs: logs.rowCount ?? 0, runs: runs.rowCount ?? 0 };
}

// --- relay-side ---------------------------------------------------------------

/** Lock a batch of queued runs not yet handed to Temporal; skips rows other relays hold. */
export async function lockPending(db: Queryable, instanceId: string, limit: number): Promise<JobRun[]> {
  const { rows } = await db.query<JobRun>(
    `select * from jobs.job_runs
      where status = 'queued' and temporal_workflow_id is null and instance_id = $1
      order by created_at
      limit $2
        for update skip locked`,
    [instanceId, limit],
  );
  return rows;
}

export async function markHandedOff(db: Queryable, id: string, workflowId: string, temporalRunId: string): Promise<void> {
  await db.query('update jobs.job_runs set temporal_workflow_id = $2, temporal_run_id = $3 where id = $1', [id, workflowId, temporalRunId]);
}
