-- 0029 · Jobs ledger (docs/jobs-temporal-design.md).
--   Postgres is the source of truth for background job runs, their attempts
--   and logs; Temporal is only the executor. Triggers insert `queued` rows in
--   their own transaction (transactional outbox); the worker's relay starts
--   the Temporal workflow with workflowId = job_runs.id.
create schema if not exists jobs;

create table if not exists jobs.job_runs (
  id                   uuid primary key default gen_random_uuid(),
  job_type             text not null,
  -- What the run is about (e.g. a connection id); coalescing key per job_type.
  subject_key          text not null,
  tenant_id            uuid references public.users(id) on delete set null,
  instance_id          text not null,
  status               text not null default 'queued'
                       check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  input                jsonb not null default '{}'::jsonb,
  result               jsonb,
  error_message        text,
  -- Sanitized, user-safe failure text; raw errors stay admin-only.
  user_message         text,
  attempts             integer not null default 0,
  temporal_workflow_id text,
  temporal_run_id      text,
  -- Set when this run is an admin retry of an earlier failed/cancelled run.
  retry_of             uuid references jobs.job_runs(id) on delete set null,
  requested_by         text,
  created_at           timestamptz not null default now(),
  started_at           timestamptz,
  finished_at          timestamptz
);

-- At most one active run per (job_type, subject_key): concurrent requests join it.
create unique index if not exists job_runs_active_unique
  on jobs.job_runs (job_type, subject_key)
  where status in ('queued', 'running');
create index if not exists job_runs_status_created_idx on jobs.job_runs (status, created_at);
create index if not exists job_runs_instance_created_idx on jobs.job_runs (instance_id, created_at desc);
create index if not exists job_runs_tenant_idx on jobs.job_runs (tenant_id) where tenant_id is not null;

create table if not exists jobs.job_attempts (
  run_id        uuid not null references jobs.job_runs(id) on delete cascade,
  attempt_no    integer not null,
  worker_id     text,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  status        text not null default 'running' check (status in ('running', 'succeeded', 'failed', 'cancelled')),
  error_message text,
  error_stack   text,
  error_code    text,
  primary key (run_id, attempt_no)
);

create table if not exists jobs.job_logs (
  id         bigserial primary key,
  run_id     uuid not null references jobs.job_runs(id) on delete cascade,
  attempt_no integer not null,
  ts         timestamptz not null default now(),
  level      text not null check (level in ('debug', 'info', 'warn', 'error')),
  message    text not null,
  fields     jsonb
);
create index if not exists job_logs_run_idx on jobs.job_logs (run_id, attempt_no, id);
create index if not exists job_logs_ts_idx on jobs.job_logs (ts);
