/**
 * Jev key store: every SQL statement of the feature. One key per user, so
 * saving replaces the row (key resolution is singular: the owner's own key
 * wins, else the installation's shared one).
 */
import type { Queryable } from '../core/db';

export type StoredJevKey = {
  user_id: string;
  key_ciphertext: Buffer;
  key_nonce: Buffer;
  key_version: number;
  last_four: string;
  updated_at: string;
};

export async function getJevKey(db: Queryable, userId: string): Promise<StoredJevKey | null> {
  const { rows } = await db.query<StoredJevKey>(
    `select user_id, key_ciphertext, key_nonce, key_version, last_four, updated_at
       from public.jev_keys where user_id = $1`,
    [userId],
  );
  return rows[0] ?? null;
}

export async function saveJevKey(
  db: Queryable,
  userId: string,
  sealed: { ciphertext: Uint8Array; nonce: Uint8Array; keyVersion: number },
  lastFour: string,
): Promise<StoredJevKey> {
  const { rows } = await db.query<StoredJevKey>(
    `insert into public.jev_keys (user_id, key_ciphertext, key_nonce, key_version, last_four)
     values ($1, $2, $3, $4, $5)
     on conflict (user_id) do update
       set key_ciphertext = excluded.key_ciphertext,
           key_nonce = excluded.key_nonce,
           key_version = excluded.key_version,
           last_four = excluded.last_four,
           updated_at = now()
     returning user_id, key_ciphertext, key_nonce, key_version, last_four, updated_at`,
    [userId, Buffer.from(sealed.ciphertext), Buffer.from(sealed.nonce), sealed.keyVersion, lastFour],
  );
  return rows[0]!;
}

/** Delete the user's key; false when there was none. */
export async function deleteJevKey(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from public.jev_keys where user_id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}
