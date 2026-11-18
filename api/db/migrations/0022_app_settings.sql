-- 0022 · App settings (v1.1 — connection sync-window config).
--   Generic key/value store for single-value product settings. The first
--   consumer is the connections sync window: how far back the initial
--   (watermark-less) pull reaches, configured on the connect-bank page.
create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
