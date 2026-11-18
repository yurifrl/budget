-- 0027 · Per-connection sync window.
--   NULL = inherit the app-wide default (app_settings 'syncWindowDays');
--   0 = all history; 1..3650 caps every pull of this connection at N days.
alter table public.connections
  add column if not exists sync_window_days integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'connections_sync_window_days_check'
  ) then
    alter table public.connections
      add constraint connections_sync_window_days_check
      check (sync_window_days is null or (sync_window_days >= 0 and sync_window_days <= 3650));
  end if;
end $$;
