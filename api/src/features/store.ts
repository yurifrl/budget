/**
 * SQL for features (public.feature_overrides, migration 0103). Functions take
 * a Queryable. A row with user_id NULL is the value for everyone; a row with
 * a user_id is that user's override. Keys are always passed in from the list
 * in code, so a stored key that is no longer listed is never read.
 */
import type { Queryable } from '../core/db';
import type { FeatureKey } from '@shared/features';

export interface StoredValue {
  feature_key: string;
  /** null = the value for everyone. */
  user_id: string | null;
  value: boolean;
}

/** The everyone value and `userId`'s override (when there is a user) of each given feature. */
export async function storedValuesFor(db: Queryable, keys: readonly FeatureKey[], userId: string | null): Promise<StoredValue[]> {
  const { rows } = await db.query<StoredValue>(
    `select feature_key, user_id, value
       from public.feature_overrides
      where feature_key = any($1::text[]) and (user_id is null or user_id = $2::uuid)`,
    [keys, userId],
  );
  return rows;
}

export interface StoredValueDetail extends StoredValue {
  changed_by: string | null;
  changed_by_email: string | null;
  changed_by_name: string | null;
  changed_at: Date;
}

/** Every stored value of the given features with who set it and when (admin list). */
export async function listStoredValues(db: Queryable, keys: readonly FeatureKey[]): Promise<StoredValueDetail[]> {
  const { rows } = await db.query<StoredValueDetail>(
    `select o.feature_key, o.user_id, o.value, o.changed_by, cb.email as changed_by_email, cb.name as changed_by_name, o.changed_at
       from public.feature_overrides o
       left join public.users cb on cb.id = o.changed_by
       left join public.users u on u.id = o.user_id
      where o.feature_key = any($1::text[])
      order by o.feature_key, u.email nulls first, o.user_id`,
    [keys],
  );
  return rows;
}

export async function userExists(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('select 1 from public.users where id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}

/** Set the value for everyone; stores who and when. */
export async function setEveryoneValue(db: Queryable, key: FeatureKey, value: boolean, changedBy: string): Promise<void> {
  await db.query(
    `insert into public.feature_overrides (feature_key, user_id, value, changed_by)
     values ($1, null, $2, $3)
     on conflict (feature_key) where user_id is null
     do update set value = excluded.value, changed_by = excluded.changed_by, changed_at = now()`,
    [key, value, changedBy],
  );
}

/** Remove the value for everyone; false when there was none. */
export async function clearEveryoneValue(db: Queryable, key: FeatureKey): Promise<boolean> {
  const { rowCount } = await db.query('delete from public.feature_overrides where feature_key = $1 and user_id is null', [key]);
  return (rowCount ?? 0) > 0;
}

/** Set one user's override; stores who and when. */
export async function setUserValue(db: Queryable, key: FeatureKey, userId: string, value: boolean, changedBy: string): Promise<void> {
  await db.query(
    `insert into public.feature_overrides (feature_key, user_id, value, changed_by)
     values ($1, $2, $3, $4)
     on conflict (feature_key, user_id) where user_id is not null
     do update set value = excluded.value, changed_by = excluded.changed_by, changed_at = now()`,
    [key, userId, value, changedBy],
  );
}

/** Remove one user's override; false when there was none. */
export async function clearUserValue(db: Queryable, key: FeatureKey, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from public.feature_overrides where feature_key = $1 and user_id = $2', [key, userId]);
  return (rowCount ?? 0) > 0;
}
