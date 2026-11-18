-- 0031 · Connection sync state (docs/jobs-temporal-design.md Q17/Q19).
--   connections.status stays a free text column (no check constraint), now
--   also holding 'quota_exhausted' (stale-not-broken: sync paused until
--   next_poll_at, the start of next month). `status_message` is the sanitized,
--   user-facing reason for a non-connected status (set by the sync job and the
--   Pluggy item/error webhook, cleared on success). next_poll_at/poll_failures
--   from 0014 are kept: next_poll_at now only gates quota pauses, and the
--   Temporal retry policy replaces the poll_failures backoff.
alter table public.connections add column if not exists status_message text;
