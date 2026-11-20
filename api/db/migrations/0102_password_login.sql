-- 0102 · e-mail + password sign-in. NEW tables only: this database is shared
--   with the running syscd-app, which never names them (public.users is not
--   altered).
--
--   user_passwords: the password credential of an "admin-managed" user (one
--     row per user; only an admin creates one, by creating the user or by
--     resetting a password). password_hash is argon2id (Bun.password, PHC
--     string); a temporary password is stored hashed like any other, with
--     must_change = true and temp_expires_at set. session_version is copied
--     into every password session (JWT claim `pwv`); bumping it (password
--     change, admin reset) ends every password session minted before.
--     Deleting the user deletes the row.
--
--   auth_login_throttle: consecutive failed password attempts per normalised
--     e-mail (also for e-mails that have no account, so a lockout cannot tell
--     accounts apart). Keyed by e-mail text, no foreign key.
create table if not exists public.user_passwords (
  user_id uuid primary key references public.users (id) on delete cascade,
  password_hash text not null,
  must_change boolean not null default false,
  temp_expires_at timestamptz,
  session_version integer not null default 1,
  changed_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.auth_login_throttle (
  email text primary key,
  failures integer not null default 0,
  locked_until timestamptz,
  last_failure_at timestamptz not null default now()
);

create index if not exists auth_login_throttle_last_failure_idx on public.auth_login_throttle (last_failure_at);
