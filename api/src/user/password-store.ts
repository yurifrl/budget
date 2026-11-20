/**
 * SQL for password sign-in: the credential (public.user_passwords), the
 * per-e-mail throttle (public.auth_login_throttle) and the non-creating user
 * lookups password sessions need. Functions take a Queryable (pool or a
 * transaction client). Never selects a hash outside `findPasswordAccount`.
 */
import type { Queryable } from '../core/db';
import { lockSecondsAfter } from './throttle';
import type { IdentityRole, IdentityStatus, IdentityUser } from './types';

const norm = (email: string) => email.toLowerCase().trim();

export interface PasswordAccount {
  userId: string;
  email: string;
  status: IdentityStatus;
  /** null = the user has no password row. */
  password: { hash: string; mustChange: boolean; tempExpiresAt: Date | null; version: number } | null;
}

/** The user row for `email` with its password row, or null when no user has this e-mail. */
export async function findPasswordAccount(db: Queryable, email: string): Promise<PasswordAccount | null> {
  const { rows } = await db.query<{
    id: string;
    email: string;
    status: IdentityStatus;
    password_hash: string | null;
    must_change: boolean | null;
    temp_expires_at: Date | null;
    session_version: number | null;
  }>(
    `select u.id, u.email, u.status, p.password_hash, p.must_change, p.temp_expires_at, p.session_version
       from public.users u
       left join public.user_passwords p on p.user_id = u.id
      where u.email = $1`,
    [norm(email)],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    userId: r.id,
    email: r.email,
    status: r.status,
    password:
      r.password_hash === null
        ? null
        : { hash: r.password_hash, mustChange: !!r.must_change, tempExpiresAt: r.temp_expires_at, version: r.session_version ?? 0 },
  };
}

/** What the per-request session rule needs: status and the password version (null = no password row). */
export interface SessionAccountState {
  status: IdentityStatus;
  passwordVersion: number | null;
}

export async function sessionAccountState(db: Queryable, email: string): Promise<SessionAccountState | null> {
  const { rows } = await db.query<{ status: IdentityStatus; session_version: number | null }>(
    `select u.status, p.session_version
       from public.users u
       left join public.user_passwords p on p.user_id = u.id
      where u.email = $1`,
    [norm(email)],
  );
  const r = rows[0];
  return r ? { status: r.status, passwordVersion: r.session_version } : null;
}

/**
 * Give `userId` a password (insert or replace). Replacing bumps
 * session_version, which ends every password session minted before.
 * Returns the new version.
 */
export async function setPassword(
  db: Queryable,
  userId: string,
  hash: string,
  opts: { mustChange: boolean; tempExpiresAt: Date | null },
): Promise<number> {
  const { rows } = await db.query<{ session_version: number }>(
    `insert into public.user_passwords (user_id, password_hash, must_change, temp_expires_at)
     values ($1, $2, $3, $4)
     on conflict (user_id) do update
       set password_hash = excluded.password_hash,
           must_change = excluded.must_change,
           temp_expires_at = excluded.temp_expires_at,
           session_version = public.user_passwords.session_version + 1,
           changed_at = now()
     returning session_version`,
    [userId, hash, opts.mustChange, opts.tempExpiresAt],
  );
  return rows[0]!.session_version;
}

/**
 * Replace the password only if the row is still at `expectedVersion` (and,
 * with `requireMustChange`, still holds a temporary password). This is what
 * makes a change token single-use and a concurrent change lose cleanly.
 * Returns the new version, or null when the row moved on.
 */
export async function replacePasswordIfVersion(
  db: Queryable,
  userId: string,
  expectedVersion: number,
  hash: string,
  requireMustChange: boolean,
): Promise<number | null> {
  const { rows } = await db.query<{ session_version: number }>(
    `update public.user_passwords
        set password_hash = $3, must_change = false, temp_expires_at = null,
            session_version = session_version + 1, changed_at = now()
      where user_id = $1 and session_version = $2 and ($4::boolean = false or must_change)
      returning session_version`,
    [userId, expectedVersion, hash, requireMustChange],
  );
  return rows[0]?.session_version ?? null;
}

/**
 * OAuth grants approved from a password session die with the password: a
 * change or an admin reset revokes them (they are sessions by proxy).
 */
export async function revokePasswordGrants(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `update public.oauth_grants set revoked_at = now() where user_id = $1 and idp = 'password' and revoked_at is null`,
    [userId],
  );
}

/** Stamp a password sign-in on an EXISTING row (never inserts). */
export async function stampSignIn(db: Queryable, userId: string): Promise<void> {
  await db.query(
    `update public.users set signed_in_at = coalesce(signed_in_at, now()), last_seen_at = now() where id = $1`,
    [userId],
  );
}

/**
 * The per-request resolver for password principals: like
 * resolveOrCreateSessionUser (stamps last_seen_at / signed_in_at) but it
 * NEVER creates a row. null = no user has this e-mail any more.
 */
export async function findSessionUser(db: Queryable, email: string): Promise<IdentityUser | null> {
  const { rows } = await db.query<{ id: string; email: string; name: string | null; google_sub: string | null; role: IdentityRole; status: IdentityStatus }>(
    `update public.users set last_seen_at = now(), signed_in_at = coalesce(signed_in_at, now())
      where email = $1
      returning id, email, name, google_sub, role, status`,
    [norm(email)],
  );
  const r = rows[0];
  return r ? { id: r.id, email: r.email, name: r.name ?? undefined, googleSub: r.google_sub, role: r.role, status: r.status } : null;
}

// ---- throttle ----------------------------------------------------------------

/** When the e-mail's lock ends; null = not locked now. */
export async function lockedUntil(db: Queryable, email: string): Promise<Date | null> {
  const { rows } = await db.query<{ locked_until: Date }>(
    `select locked_until from public.auth_login_throttle where email = $1 and locked_until > now()`,
    [norm(email)],
  );
  return rows[0]?.locked_until ?? null;
}

/**
 * Count one failed attempt for `email` (any string: unknown e-mails too) and
 * lock it when the count reaches the threshold (see ./throttle.ts). A count
 * whose last failure is over a day old starts again. Old rows are pruned.
 */
export async function recordFailure(db: Queryable, email: string): Promise<void> {
  const e = norm(email).slice(0, 320);
  const { rows } = await db.query<{ failures: number }>(
    `insert into public.auth_login_throttle (email, failures, last_failure_at) values ($1, 1, now())
     on conflict (email) do update
       set failures = case when public.auth_login_throttle.last_failure_at < now() - interval '1 day' then 1
                           else public.auth_login_throttle.failures + 1 end,
           last_failure_at = now()
     returning failures`,
    [e],
  );
  const failures = rows[0]!.failures;
  const seconds = lockSecondsAfter(failures);
  if (seconds > 0) {
    await db.query(
      `update public.auth_login_throttle set locked_until = now() + make_interval(secs => $2) where email = $1 and failures = $3`,
      [e, seconds, failures],
    );
  }
  // Opportunistic pruning keeps the table small without a scheduler.
  await db.query(
    `delete from public.auth_login_throttle
      where last_failure_at < now() - interval '1 day' and (locked_until is null or locked_until < now())`,
  );
}

export async function clearThrottle(db: Queryable, email: string): Promise<void> {
  await db.query('delete from public.auth_login_throttle where email = $1', [norm(email)]);
}
