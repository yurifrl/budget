/**
 * The person-avatar contract — the ONE shape every API that returns a person
 * carries, and the ONE SQL fragment / mapper that derives it.
 *
 * Semantics:
 *  - `seed`: seed of the generated avatar (client: core/avatar/generate). The
 *    stored `users.avatar_seed` when set, else the user id — so every user
 *    (including pre-provisioned, never-signed-in rows) has a stable avatar
 *    with no backfill.
 *  - `image_version`: non-null ⇒ the user has an uploaded photo, fetchable at
 *    `/users/:id/avatar?v=<image_version>` (the version is the cache-busting
 *    key, bumped on every upload/remove). null ⇒ render the generated avatar.
 */
export type PersonAvatar = {
  seed: string;
  image_version: number | null;
};

/** Row columns produced by {@link personAvatarSql}. */
export type PersonAvatarRow = {
  avatar_seed: string;
  avatar_image_version: number | null;
};

const SQL_ALIAS = /^[a-z_][a-z0-9_]*$/i;

/**
 * SQL select-list fragment (two columns, no trailing comma) deriving the
 * {@link PersonAvatarRow} for the `public.users` row aliased `alias`:
 *
 *   select u.id, ${personAvatarSql('u')} from public.users u
 *
 * Joins nothing — the photo-exists check is a correlated subquery on the
 * user_avatars primary key — so any query that already has a users alias can
 * embed it as-is. `alias` is interpolated, so it must be a plain identifier.
 */
export function personAvatarSql(alias: string): string {
  if (!SQL_ALIAS.test(alias)) throw new Error(`invalid SQL alias: ${alias}`);
  return `coalesce(${alias}.avatar_seed, ${alias}.id::text) as avatar_seed,
       case when exists (select 1 from public.user_avatars ua where ua.user_id = ${alias}.id)
            then ${alias}.avatar_version end as avatar_image_version`;
}

/** Map the columns produced by {@link personAvatarSql} to the API shape. */
export function toPersonAvatar(row: PersonAvatarRow): PersonAvatar {
  return { seed: row.avatar_seed, image_version: row.avatar_image_version };
}
