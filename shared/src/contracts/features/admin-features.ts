/**
 * Admin feature management (/admin/features). Admin role AND a first-party
 * session (an OAuth access token or the service token gets 403). Api only.
 *
 * A feature has one optional value for everyone and optional per-user
 * overrides; clearing one makes the next level apply (user override, else
 * everyone, else the default in code). Every write stores who and when.
 *
 * Errors (body `{ error, code }`):
 *  - 400 `invalid_input`: `key` is not a feature in the list;
 *  - 401 `unauthorized` / `account_disabled`; 403 `forbidden` (not an admin,
 *    or not a first-party session); 403 `origin_not_allowed` (writes);
 *  - 404 `not_found`: no such user (set user override).
 */
import { z } from '../../zod';

import { featureKeySchema } from '../../features';
import { defineOperation, type OperationExpose } from '../../operation-contract';
import { uuidSchema } from '../../validation';
import { adminFeatureSchema } from './outputs';

const EXPOSE_API_ONLY: OperationExpose = { api: true, cli: false, mcp: false };

export const featuresAdminList = defineOperation({
  name: 'features_admin_list',
  description: 'Admin: every feature in the list with its default, the value for everyone and the per-user overrides.',
  input: z.object({}),
  output: z.array(adminFeatureSchema),
  method: 'GET',
  path: '/admin/features',
  kind: 'read',
  expose: EXPOSE_API_ONLY,
});

export const featuresAdminSetEveryone = defineOperation({
  name: 'features_admin_set_everyone',
  description: 'Admin: turn a feature on or off for everyone (people with their own override keep it).',
  input: z.object({ key: featureKeySchema, value: z.boolean() }),
  output: adminFeatureSchema,
  method: 'PUT',
  path: '/admin/features/:key/everyone',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const featuresAdminClearEveryone = defineOperation({
  name: 'features_admin_clear_everyone',
  description: 'Admin: remove the value for everyone, so the default in code applies again.',
  input: z.object({ key: featureKeySchema }),
  output: adminFeatureSchema,
  method: 'DELETE',
  path: '/admin/features/:key/everyone',
  kind: 'destructive',
  expose: EXPOSE_API_ONLY,
});

export const featuresAdminSetUser = defineOperation({
  name: 'features_admin_set_user',
  description: 'Admin: turn a feature on or off for one user, whatever the value for everyone is.',
  input: z.object({ key: featureKeySchema, user_id: uuidSchema, value: z.boolean() }),
  output: adminFeatureSchema,
  method: 'PUT',
  path: '/admin/features/:key/users/:user_id',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const featuresAdminClearUser = defineOperation({
  name: 'features_admin_clear_user',
  description: 'Admin: remove one user override, so the user inherits the value for everyone (or the default).',
  input: z.object({ key: featureKeySchema, user_id: uuidSchema }),
  output: adminFeatureSchema,
  method: 'DELETE',
  path: '/admin/features/:key/users/:user_id',
  kind: 'destructive',
  expose: EXPOSE_API_ONLY,
});
