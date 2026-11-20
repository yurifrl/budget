/**
 * SQL for admin user management (/admin/users). Functions take a Queryable;
 * multi-statement writes run in the caller's transaction. Synthetic rows (the
 * service user, the dev user) and placeholders (no e-mail) are never listed
 * or manageable.
 */
import type { Queryable } from '../core/db';
import type { AdminUser } from '@shared/contracts/user/admin-users';
import { SVC_EMAIL, userReferenceColumns } from './store';
import type { IdentityRole, IdentityStatus } from './types';

/** E-mails of rows the app creates for itself; never manageable. */
export const SYNTHETIC_EMAILS: readonly string[] = [SVC_EMAIL, 'dev@localhost'];

// Advisory-lock key serialising admin role/status/delete changes, so two
// admins demoting each other at once cannot leave zero active admins.
const ADMIN_GUARD_LOCK_KEY = 7_204_102;

type Row = {
  id: string;
  email: string;
  name: string | null;
  role: IdentityRole;
  status: IdentityStatus;
  has_password: boolean;
  must_change: boolean | null;
  temp_expires_at: Date | null;
  locked_until: Date | null;
  google_sub: string | null;
  signed_in_at: Date | null;
  last_seen_at: Date;
  created_at: Date;
};

const SELECT = `
  select u.id, u.email, u.name, u.role, u.status,
         (p.user_id is not null) as has_password, p.must_change, p.temp_expires_at,
         case when t.locked_until > now() then t.locked_until end as locked_until,
         u.google_sub, u.signed_in_at, u.last_seen_at, u.created_at
    from public.users u
    left join public.user_passwords p on p.user_id = u.id
    left join public.auth_login_throttle t on t.email = u.email
   where u.email is not null and not (u.email = any($1::text[]))`;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

const toAdminUser = (r: Row): AdminUser => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  status: r.status,
  has_password: r.has_password,
  must_change_password: !!r.must_change,
  temp_expires_at: iso(r.temp_expires_at),
  locked_until: iso(r.locked_until),
  has_google: r.google_sub !== null,
  signed_in_at: iso(r.signed_in_at),
  last_seen_at: r.last_seen_at.toISOString(),
  created_at: r.created_at.toISOString(),
});

export async function listManagedUsers(db: Queryable): Promise<AdminUser[]> {
  const { rows } = await db.query<Row>(`${SELECT} order by u.email`, [SYNTHETIC_EMAILS]);
  return rows.map(toAdminUser);
}

/** A manageable user by id; null = no such row, or a synthetic/placeholder one. */
export async function getManagedUser(db: Queryable, id: string, forUpdate = false): Promise<AdminUser | null> {
  const { rows } = await db.query<Row>(`${SELECT} and u.id = $2${forUpdate ? ' for update of u' : ''}`, [SYNTHETIC_EMAILS, id]);
  return rows[0] ? toAdminUser(rows[0]) : null;
}

/** Insert a new user row; null when the e-mail is taken. Never seeds the first admin. */
export async function insertUser(db: Queryable, email: string, name: string | null, role: IdentityRole): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into public.users (id, email, name, role) values (gen_random_uuid(), $1, $2, $3)
     on conflict (email) do nothing returning id`,
    [email.toLowerCase().trim(), name, role],
  );
  return rows[0]?.id ?? null;
}

export async function lockAdminGuard(db: Queryable): Promise<void> {
  await db.query('select pg_advisory_xact_lock($1)', [ADMIN_GUARD_LOCK_KEY]);
}

/** Active admins other than `exceptId`. */
export async function otherActiveAdmins(db: Queryable, exceptId: string): Promise<number> {
  const { rows } = await db.query<{ n: number }>(
    `select count(*)::int as n from public.users where role = 'admin' and status = 'active' and id <> $1`,
    [exceptId],
  );
  return rows[0]!.n;
}

export async function updateUserFields(
  db: Queryable,
  id: string,
  patch: { name?: string | null; role?: IdentityRole; status?: IdentityStatus },
): Promise<void> {
  const sets: string[] = [];
  const values: unknown[] = [id];
  for (const key of ['name', 'role', 'status'] as const) {
    if (patch[key] === undefined) continue;
    values.push(patch[key]);
    sets.push(`${key} = $${values.length}`);
  }
  if (sets.length === 0) return;
  await db.query(`update public.users set ${sets.join(', ')} where id = $1`, values);
}

/** Tables that are the user's own credentials, not data: they go with the user. */
const CREDENTIAL_TABLES = new Set(['public.user_passwords']);

/** Tables (other than credentials) holding rows that reference the user. */
export async function userDataReferences(db: Queryable, id: string): Promise<string[]> {
  const found: string[] = [];
  for (const { table, column } of await userReferenceColumns(db)) {
    if (CREDENTIAL_TABLES.has(table)) continue;
    const { rowCount } = await db.query(`select 1 from ${table} where ${column} = $1 limit 1`, [id]);
    if ((rowCount ?? 0) > 0) found.push(table);
  }
  return found;
}

export async function removeUserRow(db: Queryable, id: string): Promise<void> {
  await db.query('delete from public.users where id = $1', [id]);
}
