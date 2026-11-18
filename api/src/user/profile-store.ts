/**
 * Profile persistence: the signed-in user's own profile (name, generated
 * avatar seed) and uploaded photo. Reads derive the avatar through the shared
 * {@link personAvatarSql} so the rule lives in one place.
 */
import { pool } from '../core/db';
import { personAvatarSql, toPersonAvatar, type PersonAvatar, type PersonAvatarRow } from './avatar';
import type { IdentityRole } from './types';

export type Profile = {
  id: string;
  email: string;
  name: string | null;
  role: IdentityRole;
  avatar: PersonAvatar;
};

type ProfileRow = PersonAvatarRow & { id: string; email: string; name: string | null; role: IdentityRole };

const toProfile = (r: ProfileRow): Profile => ({
  id: r.id,
  email: r.email,
  name: r.name,
  role: r.role,
  avatar: toPersonAvatar(r),
});

export async function getProfile(userId: string): Promise<Profile | null> {
  const { rows } = await pool.query<ProfileRow>(
    `select u.id, u.email, u.name, u.role, ${personAvatarSql('u')} from public.users u where u.id = $1`,
    [userId],
  );
  return rows[0] ? toProfile(rows[0]) : null;
}

export type ProfilePatch = {
  name?: string;
  /** string = pick that generated look; null = back to the default (user id). */
  avatar_seed?: string | null;
};

/**
 * Update name and/or generated-avatar seed. Choosing a generated look also
 * drops any uploaded photo (and bumps the version) in the same transaction —
 * "use this avatar" is one atomic act, never a half-state.
 */
export async function updateProfile(userId: string, patch: ProfilePatch): Promise<Profile | null> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (patch.name !== undefined) {
      await client.query('update public.users set name = $2 where id = $1', [userId, patch.name]);
    }
    if (patch.avatar_seed !== undefined) {
      await client.query('update public.users set avatar_seed = $2 where id = $1', [userId, patch.avatar_seed]);
      await removePhoto(client, userId);
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return getProfile(userId);
}

type Queryable = Pick<typeof pool, 'query'>;

async function removePhoto(db: Queryable, userId: string): Promise<void> {
  const del = await db.query('delete from public.user_avatars where user_id = $1', [userId]);
  if (del.rowCount) await db.query('update public.users set avatar_version = avatar_version + 1 where id = $1', [userId]);
}

export async function setAvatarPhoto(userId: string, contentType: string, bytes: Uint8Array): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      `insert into public.user_avatars (user_id, content_type, bytes) values ($1, $2, $3)
       on conflict (user_id) do update set content_type = excluded.content_type,
         bytes = excluded.bytes, updated_at = now()`,
      [userId, contentType, Buffer.from(bytes)],
    );
    await client.query('update public.users set avatar_version = avatar_version + 1 where id = $1', [userId]);
    await client.query('commit');
  } catch (err) {
    await client.query('rollback').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function removeAvatarPhoto(userId: string): Promise<void> {
  await removePhoto(pool, userId);
}

export type AvatarPhoto = { contentType: string; bytes: Buffer; version: number };

export async function getAvatarPhoto(userId: string): Promise<AvatarPhoto | null> {
  const { rows } = await pool.query<{ content_type: string; bytes: Buffer; avatar_version: number }>(
    `select ua.content_type, ua.bytes, u.avatar_version
       from public.user_avatars ua join public.users u on u.id = ua.user_id
      where ua.user_id = $1`,
    [userId],
  );
  return rows[0] ? { contentType: rows[0].content_type, bytes: rows[0].bytes, version: rows[0].avatar_version } : null;
}
