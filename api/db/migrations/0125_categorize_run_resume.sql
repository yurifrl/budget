-- 0125 · Categorize run: resumable progress and a failure code. Additive only:
--   two NEW columns, which the running syscd-app (sharing this database) never
--   names.
--
--   1. public.categorize_attempts.last_run_id: the run that wrote the row.
--      A run skips rows it already answered (same run, redelivered activity)
--      instead of asking again and folding a second answer into the first, so
--      Temporal's at-least-once retries are idempotent.
--   2. public.categorize_run_progress.failure: the code of the RunFailure that
--      closed the run, so the page can say WHY a failed run failed instead of
--      showing one generic "failed" for a refused key and a crash.
alter table public.categorize_attempts
  add column if not exists last_run_id uuid references jobs.job_runs (id) on delete set null;
create index if not exists categorize_attempts_run_idx
  on public.categorize_attempts (last_run_id);

alter table public.categorize_run_progress
  add column if not exists failure text;
