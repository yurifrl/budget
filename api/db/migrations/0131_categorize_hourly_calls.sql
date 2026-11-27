-- 0131 · Categorize: the hourly allowance counts CALLS, not rows. Additive
--   only: two NEW columns the running syscd-app (sharing this database) never
--   names; a writer that does not set them leaves 0 / null, which counts
--   nothing (the allowance may under-count, never over-count).
--
--   public.categorize_attempts.hour_calls: the calls that cost (a model was
--   used) made for this row since hour_started_at. A call inside the hour adds
--   one; the first call after the hour starts a new window at 1.
--   public.categorize_attempts.hour_started_at: when that window started (the
--   first counted call in it); null while the row has none.
alter table public.categorize_attempts
  add column if not exists hour_calls integer not null default 0;
alter table public.categorize_attempts
  add column if not exists hour_started_at timestamptz;
