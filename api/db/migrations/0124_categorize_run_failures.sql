-- 0124 · Categorize run failures (the "Categorize" page status). Additive only:
--   one NEW column on the feature's own progress table (0114), which the
--   running syscd-app (sharing this database) never names.
--
--   categorize_run_status reports `failures`: how many of the run's
--   transactions the Jev call could not answer for. Done/total alone cannot
--   say it, and counting attempts after the fact cannot attribute them to one
--   run.
alter table public.categorize_run_progress
  add column if not exists failures integer not null default 0;
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'categorize_run_progress_failures_check'
  ) then
    alter table public.categorize_run_progress
      add constraint categorize_run_progress_failures_check check (failures >= 0);
  end if;
end $$;
