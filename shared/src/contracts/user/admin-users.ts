/**
 * Admin user management (/admin/users). Admin role AND a first-party session
 * (an OAuth access token or the service token gets 403). Api only.
 *
 * Errors (body `{ error, code }`):
 *  - 401 `unauthorized` / `account_disabled`; 403 `forbidden` (not an admin,
 *    or not a first-party session); 403 `origin_not_allowed` (writes);
 *  - 404 `not_found`: no such user, or a synthetic/placeholder row;
 *  - 409 `user_exists` (create: e-mail taken);
 *  - 409 `cannot_modify_self`: an admin disabling, demoting or deleting themself;
 *  - 409 `last_admin`: disabling, demoting or deleting the last active admin;
 *  - 409 `user_has_data` (delete: rows reference the user; disable instead);
 *  - 409 `password_login_disabled` (create, reset-password: AUTH_PASSWORD_LOGIN=0).
 */
import { z } from '../../zod';

import { defineOperation, type OperationExpose } from '../../operation-contract';
import { uuidSchema } from '../../validation';

const EXPOSE_API_ONLY: OperationExpose = { api: true, cli: false, mcp: false };

export const adminUserSchema = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: z.enum(['admin', 'user']),
  status: z.enum(['active', 'disabled']),
  /** Admin-managed: has a password (and so may also sign in with Google by the same e-mail). */
  has_password: z.boolean(),
  /** Holds a temporary password that must be changed at the next sign-in. */
  must_change_password: z.boolean(),
  /** ISO timestamp the temporary password expires; null when none. */
  temp_expires_at: z.string().nullable(),
  /** ISO timestamp until which password sign-in is locked after failures; null when not locked. */
  locked_until: z.string().nullable(),
  has_google: z.boolean(),
  signed_in_at: z.string().nullable(),
  last_seen_at: z.string(),
  created_at: z.string(),
});
export type AdminUser = z.infer<typeof adminUserSchema>;

/** A user plus the temporary password, shown ONCE (it is never stored in clear and cannot be read again). */
export const adminUserWithTempPasswordSchema = z.object({ user: adminUserSchema, temp_password: z.string() });
export type AdminUserWithTempPassword = z.infer<typeof adminUserWithTempPasswordSchema>;

export const adminUsersList = defineOperation({
  name: 'user_admin_users_list',
  description: 'Admin: every person who can sign in (synthetic and placeholder rows excluded), by e-mail.',
  input: z.object({}),
  output: z.array(adminUserSchema),
  method: 'GET',
  path: '/admin/users',
  kind: 'read',
  expose: EXPOSE_API_ONLY,
});

export const adminUsersCreate = defineOperation({
  name: 'user_admin_users_create',
  description: 'Admin: create a user with a server-generated temporary password (7 days, must be changed at first sign-in), returned once.',
  input: z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    name: z.string().trim().min(1).max(80).optional(),
    role: z.enum(['admin', 'user']).optional(),
  }),
  output: adminUserWithTempPasswordSchema,
  method: 'POST',
  path: '/admin/users',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
  status: 201,
});

export const adminUsersUpdate = defineOperation({
  name: 'user_admin_users_update',
  description: 'Admin: change a user name, role or status. The e-mail cannot be changed.',
  input: z.object({
    id: uuidSchema,
    name: z.string().trim().min(1).max(80).nullable().optional(),
    role: z.enum(['admin', 'user']).optional(),
    status: z.enum(['active', 'disabled']).optional(),
  }),
  output: adminUserSchema,
  method: 'PATCH',
  path: '/admin/users/:id',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const adminUsersResetPassword = defineOperation({
  name: 'user_admin_users_reset_password',
  description:
    'Admin: give a user (any user, also one who so far used Google or Access) a new temporary password, returned once; it must be changed at the next sign-in, expires in 7 days, clears the sign-in lockout and ends the user password sessions.',
  input: z.object({ id: uuidSchema }),
  output: adminUserWithTempPasswordSchema,
  method: 'POST',
  path: '/admin/users/:id/reset-password',
  kind: 'write',
  expose: EXPOSE_API_ONLY,
});

export const adminUsersDelete = defineOperation({
  name: 'user_admin_users_delete',
  description: 'Admin: delete a user that nothing references (no budgets, memberships, accounts...); otherwise 409 user_has_data (disable instead).',
  input: z.object({ id: uuidSchema }),
  output: z.null(),
  method: 'DELETE',
  path: '/admin/users/:id',
  kind: 'destructive',
  expose: EXPOSE_API_ONLY,
});
