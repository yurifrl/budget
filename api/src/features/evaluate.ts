/**
 * Feature evaluation: the API is where a feature is enforced.
 *
 * Call `isEnabled` from request handlers and Temporal ACTIVITIES only. A
 * workflow file runs in the Temporal sandbox and cannot import this DB-backed
 * module (or the barrel): a workflow that depends on a feature asks an
 * activity.
 *
 * Every check reads the database; nothing is cached, so a change made in the
 * admin applies to the next check (as `requireUser` does for the role).
 */
import type { Queryable } from '../core/db';
import { FEATURE_KEYS, resolveFeature, type FeatureKey, type FeatureStored, type FeatureValues } from '@shared/features';
import { storedValuesFor, type StoredValue } from './store';

function storedByKey(rows: readonly StoredValue[]): Map<string, FeatureStored> {
  const byKey = new Map<string, FeatureStored>();
  for (const row of rows) {
    const stored = byKey.get(row.feature_key) ?? {};
    if (row.user_id === null) stored.everyone = row.value;
    else stored.user = row.value;
    byKey.set(row.feature_key, stored);
  }
  return byKey;
}

/**
 * Is `feature` on for this user? The user's override, else the value for
 * everyone, else the default in code. `userId` null (no person, e.g. a
 * system job) skips the user step.
 */
export async function isEnabled(db: Queryable, feature: FeatureKey, userId: string | null): Promise<boolean> {
  const rows = await storedValuesFor(db, [feature], userId);
  return resolveFeature(feature, storedByKey(rows).get(feature));
}

/** Every listed feature for this user, in one query (what GET /features answers). */
export async function evaluateFeatures(db: Queryable, userId: string | null): Promise<FeatureValues> {
  const byKey = storedByKey(await storedValuesFor(db, FEATURE_KEYS, userId));
  return Object.fromEntries(FEATURE_KEYS.map((key) => [key, resolveFeature(key, byKey.get(key))])) as FeatureValues;
}
