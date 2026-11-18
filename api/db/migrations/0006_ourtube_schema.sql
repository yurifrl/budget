-- =============================================================================
-- 0006 · OurTube schema (global scope)
--   Video feed aggregator: channels, videos, seen.
--   Primary keys: channels(channel_id), videos(video_id), seen(video_id)
--   Soft-delete: deleted + deleted_at columns
--   Upserts: ON CONFLICT (primary key) DO UPDATE
-- =============================================================================

-- ----------------------------------------------------------------------------
-- channels
-- ----------------------------------------------------------------------------
create table if not exists public.channels (
  channel_id  text primary key,
  name        text not null,
  avatar      text,
  group_name  text,
  source      text not null,
  added_at    timestamptz not null default now(),
  updated_via text,
  updated_at  timestamptz not null default now(),
  deleted     boolean not null default false,
  deleted_at  timestamptz
);

-- ----------------------------------------------------------------------------
-- videos
-- ----------------------------------------------------------------------------
create table if not exists public.videos (
  video_id       text primary key,
  title          text not null,
  channel_id     text not null,
  channel_name   text not null,
  published_at   timestamptz not null,
  thumbnail      text,
  description    text,
  url            text not null,
  fetched_at     timestamptz not null default now(),
  watched        boolean not null default false,
  watched_at     timestamptz,
  watch_later    boolean not null default false,
  watch_later_at timestamptz,
  deleted        boolean not null default false,
  deleted_at     timestamptz
);

-- ----------------------------------------------------------------------------
-- seen
-- ----------------------------------------------------------------------------
create table if not exists public.seen (
  video_id text primary key
);
