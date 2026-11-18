/**
 * "Has this person ever signed in?" — the one definition. A user row created
 * by an invite (provisionUserByEmail) has no google_sub until their first
 * Google sign-in links it; until then they are *pending*.
 */

import { personAvatarSql, toPersonAvatar, type PersonAvatar, type PersonAvatarRow } from './avatar';

/** SQL select-list fragment: `pending` boolean for the `public.users` row aliased `alias`. */
export function personPendingSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`invalid SQL alias: ${alias}`);
  return `(${alias}.google_sub is null) as pending`;
}

/** A person reference: the minimal identity a budget member may see of another (name/email/avatar). */
export type PersonRef = { user_id: string; name: string | null; email: string | null; avatar: PersonAvatar };

/** Row columns produced by {@link personRefSql}. */
export type PersonRefRow = PersonAvatarRow & { ref_user_id: string; ref_name: string | null; ref_email: string | null };

/**
 * SQL select-list fragment deriving a {@link PersonRef} from the `public.users`
 * row aliased `alias` (a left join yields all-null columns → {@link toPersonRef}
 * returns null). Map with {@link toPersonRef}; the avatar part is
 * `personAvatarSql`, so the avatar rules stay in one place.
 */
export function personRefSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(alias)) throw new Error(`invalid SQL alias: ${alias}`);
  return `${alias}.id as ref_user_id, ${alias}.name as ref_name, ${alias}.email as ref_email, ${personAvatarSql(alias)}`;
}

/** Map the {@link personRefSql} columns to the API shape; null when the user row is absent. */
export function toPersonRef(row: PersonRefRow): PersonRef | null {
  if (row.ref_user_id == null) return null;
  return { user_id: row.ref_user_id, name: row.ref_name, email: row.ref_email, avatar: toPersonAvatar(row) };
}
