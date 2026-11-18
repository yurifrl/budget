-- 0026 · User avatars (people pictures).
--   Every person gets an auto-generated avatar and may upload a photo.
--   `avatar_seed` is the seed of the generated avatar; NULL means "use the
--   user id as the seed", so every existing and pre-provisioned user already
--   has a stable avatar with zero backfill (see personAvatarSql in
--   server/user/avatar.ts — the single place that rule lives).
--   An uploaded photo (normalized server-side to <= 256px, a few KB) lives in
--   its own table so the hot `users` row stays small; `avatar_version` is the
--   cache-busting key, bumped on every upload/remove (clients request
--   /users/:id/avatar?v=<version> with an immutable cache lifetime).
alter table public.users
  add column if not exists avatar_seed text,
  add column if not exists avatar_version integer not null default 0;

create table if not exists public.user_avatars (
  user_id      uuid primary key references public.users(id) on delete cascade,
  content_type text not null,
  bytes        bytea not null,
  updated_at   timestamptz not null default now()
);
