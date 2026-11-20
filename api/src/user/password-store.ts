/**
 * SQL for password sign-in: the credential (public.user_passwords), the
 * per-e-mail throttle (public.auth_login_throttle) and the non-creating user
 * lookups password sessions need. Functions take a Queryable (pool or a
 * transaction client). Never selects a hash outside `findPasswordAccount`.
 */
import { withTransaction, type Queryable } from '../core/db';
import { lockSecondsAfter } from './throttle';

type TxPool = Parameters<typeof withTransaction>[0];
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

export type AttemptReservation = { allowed: true } | { allowed: false; lockedUntil: Date };

/**
 * Reserve ONE password attempt for `email` (any string: unknown e-mails too)
 * BEFORE verifying it. Row-locked, so concurrency cannot widen the budget:
 *  - locked now: refused, nothing changes (no verification may run);
 *  - otherwise the attempt is counted up front (`failures` = consecutive
 *    attempts not followed by a success; a count idle for a day restarts at
 *    1) and, from the LOCK_AFTER-th attempt on, the lock starts with this very
 *    attempt (see ./throttle.ts).
 * So at most LOCK_AFTER verifications run before the first lock and one per
 * lock window after it, whatever the concurrency. A success calls
 * {@link clearThrottle}, which forgets the count.
 */
export async function reserveAttempt(pool: TxPool, email: string): Promise<AttemptReservation> {
  const e = norm(email).slice(0, 320);
  for (let i = 0; i < 3; i++) {
    const result = await withTransaction(pool, async (tx): Promise<AttemptReservation | null> => {
      await tx.query(
        `insert into public.auth_login_throttle (email, failures, last_failure_at) values ($1, 0, now()) on conflict (email) do nothing`,
        [e],
      );
      const { rows } = await tx.query<{ failures: number; locked_until: Date | null; stale: boolean; locked: boolean }>(
        `select failures, locked_until,
                last_failure_at < now() - interval '1 day' as stale,
                coalesce(locked_until > now(), false) as locked
           from public.auth_login_throttle where email = $1 for update`,
        [e],
      );
      const row = rows[0];
      // Deleted by a concurrent success between the insert and the lock: retry.
      if (!row) return null;
      if (row.locked) return { allowed: false, lockedUntil: row.locked_until! };
      const failures = row.stale ? 1 : row.failures + 1;
      const seconds = lockSecondsAfter(failures);
      await tx.query(
        `update public.auth_login_throttle
            set failures = $2, last_failure_at = now(),
                locked_until = case when $3::int > 0 then now() + make_interval(secs => $3::int) end
          where email = $1`,
        [e, failures, seconds],
      );
      return { allowed: true };
    });
    if (result) {
      if (result.allowed && Math.random() < 0.05) await pruneThrottle(pool);
      return result;
    }
  }
  throw new Error('reserveAttempt: could not reserve an attempt');
}

/** Rows idle for a day and not locked are forgotten. */
async function pruneThrottle(pool: TxPool): Promise<void> {
  await withTransaction(pool, (tx) =>
    tx.query(
      `delete from public.auth_login_throttle
        where last_failure_at < now() - interval '1 day' and (locked_until is null or locked_until < now())`,
    ),
  );
}

export async function clearThrottle(db: Queryable, email: string): Promise<void> {
  await db.query('delete from public.auth_login_throttle where email = $1', [norm(email)]);
}
