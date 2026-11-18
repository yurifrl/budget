-- =============================================================================
-- 0017 · Poll state
--   Tiny key/value table for cross-restart poll coordination. The OurTube
--   boot tick reads it to skip itself when a recent tick already completed,
--   so process watchdogs that restart the API cannot multiply YouTube RSS
--   request volume (YouTube bot-flags over-polling as RSS 404s on live
--   channels).
-- =============================================================================

create table if not exists public.poll_state (
  key        text        primary key,
  value      text        not null,
  updated_at timestamptz not null default now()
);
