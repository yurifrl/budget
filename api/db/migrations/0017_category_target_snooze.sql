-- =============================================================================
-- 0017 · Category target snooze (YNAB parity, bead syscd-app-hsjm)
--   `snooze_month` is the single MonthKey (YYYYMM) whose need the target
--   skips — "Snooze target for this month". NULL = active every month; the
--   next month resumes automatically, no cleanup needed.
-- =============================================================================

alter table public.category_targets
  add column if not exists snooze_month integer;
