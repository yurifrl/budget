/**
 * Features routes (post-gate).
 *
 *  - GET /features: any signed-in user, their own evaluated values.
 *  - /admin/features: admin role AND a first-party session, Origin checked
 *    (the same guards as /admin/users). Each write stores who and when on the
 *    row and is logged (actor, action, feature, target, value).
 *
 * Handlers parse, authorise and shape; SQL in ./store.ts, the resolution rule
 * in @shared/features.
 */
import { Hono, type Context } from 'hono';

import { pool } from '../core/db';
import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { HttpError } from '../core/validate';
import {
  featuresAdminClearEveryone,
  featuresAdminClearUser,
  featuresAdminList,
  featuresAdminSetEveryone,
  featuresAdminSetUser,
  featuresMine,
  type AdminFeature,
  type FeatureValue,
} from '@shared/contracts/features';
import { FEATURES, FEATURE_KEYS, type FeatureKey } from '@shared/features';
import { noStore, originGuard, requireAdmin, requireFirstPartySession, requireUserId, type IdentityUser, type TrustedOrigins } from '../user';
import { evaluateFeatures } from './evaluate';
import {
  clearEveryoneValue,
  clearUserValue,
  listStoredValues,
  setEveryoneValue,
  setUserValue,
  userExists,
  type StoredValueDetail,
} from './store';

function actor(c: Context): IdentityUser {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

function audit(c: Context, action: string, feature: FeatureKey, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: 'admin_feature_action', actor: actor(c).email, action, feature, ...details }));
}

const toValue = (row: StoredValueDetail): FeatureValue => ({
  value: row.value,
  changed_by: row.changed_by ? { id: row.changed_by, email: row.changed_by_email, name: row.changed_by_name } : null,
  changed_at: row.changed_at.toISOString(),
});

/** The listed features (in list order) with what is stored for each. */
async function adminFeatures(keys: readonly FeatureKey[] = FEATURE_KEYS): Promise<AdminFeature[]> {
  const rows = await listStoredValues(pool, keys);
  return FEATURES.filter((f) => keys.includes(f.key)).map((f) => {
    const mine = rows.filter((r) => r.feature_key === f.key);
    const everyone = mine.find((r) => r.user_id === null);
    return {
      key: f.key,
      group: f.group,
      description: f.description,
      default: f.default,
      everyone: everyone ? toValue(everyone) : null,
      overrides: mine.flatMap((r) => (r.user_id === null ? [] : [{ user_id: r.user_id, ...toValue(r) }])),
    };
  });
}

const adminFeature = async (key: FeatureKey): Promise<AdminFeature> => (await adminFeatures([key]))[0]!;

export const ownOperations: readonly AnyOperation[] = [
  implement(featuresMine, async (c) => ({ features: await evaluateFeatures(pool, requireUserId(c)) })),
];

export const adminOperations: readonly AnyOperation[] = [
  implement(featuresAdminList, () => adminFeatures()),

  implement(featuresAdminSetEveryone, async (c, { key, value }) => {
    await setEveryoneValue(pool, key, value, actor(c).id);
    audit(c, 'set_everyone', key, { value });
    return adminFeature(key);
  }),

  implement(featuresAdminClearEveryone, async (c, { key }) => {
    if (await clearEveryoneValue(pool, key)) audit(c, 'clear_everyone', key);
    return adminFeature(key);
  }),

  implement(featuresAdminSetUser, async (c, { key, user_id, value }) => {
    if (!(await userExists(pool, user_id))) throw new HttpError(404, 'user not found');
    try {
      await setUserValue(pool, key, user_id, value, actor(c).id);
    } catch (err) {
      // The user was deleted between the check and the insert (foreign key).
      if ((err as { code?: string }).code === '23503') throw new HttpError(404, 'user not found');
      throw err;
    }
    audit(c, 'set_user', key, { target: user_id, value });
    return adminFeature(key);
  }),

  implement(featuresAdminClearUser, async (c, { key, user_id }) => {
    if (await clearUserValue(pool, key, user_id)) audit(c, 'clear_user', key, { target: user_id });
    return adminFeature(key);
  }),
];

export const operations: readonly AnyOperation[] = [...ownOperations, ...adminOperations];

/** Post-gate router (mount after authMiddleware + requireUser). */
export function featuresRoutes(options: { trustedOrigins?: TrustedOrigins } = {}): Hono {
  const router = new Hono();
  mountOperations(router, ownOperations, { use: [noStore] });
  mountOperations(router, adminOperations, {
    use: [noStore, originGuard(options.trustedOrigins), requireFirstPartySession, requireAdmin],
  });
  return router;
}
