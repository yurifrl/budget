-- 0114 · Categorize run progress (budget-edxg). Additive only: one NEW table,
--   which the running syscd-app (sharing this database) never names.
--
--   The chunk activity writes done/total here so categorize_run_status can
--   show the active run's progress without asking Temporal (the heartbeat
--   payload is not queryable from the API). Keyed by job run: the row is
--   deleted with its run by the jobs retention sweep (FK cascade). done only
--   grows (greatest() on upsert), so a late write cannot move the bar back.
create table if not exists public.categorize_run_progress (
  run_id     uuid primary key references jobs.job_runs (id) on delete cascade,
  budget_id  uuid not null references public.budgets (id) on delete cascade,
  done       integer not null default 0 check (done >= 0),
  total      integer not null default 0 check (total >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists categorize_run_progress_budget_idx
  on public.categorize_run_progress (budget_id);
