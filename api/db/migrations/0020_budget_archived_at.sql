-- =============================================================================
-- 0020 · Budget archive
--   Fresh Start needs "archived budgets": the old instance survives with all
--   its data, excluded from the active list, and its archive moment is
--   visible in the switcher. archived_at NULL = active; a timestamp marks an
--   archived budget. The archive rename appends the timestamp to the name
--   (e.g. "Casa 2026-10-24 14:05") so the switcher row is self-describing
--   even before the switcher renders archived_at.
-- =============================================================================

alter table public.budgets
  add column if not exists archived_at timestamptz;
