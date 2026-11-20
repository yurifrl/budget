/**
 * Admin user management (post-gate): /admin/users. Admin role AND a
 * first-party session; Origin checked. Handlers parse, authorise and shape;
 * SQL in ./admin-users-store.ts and ./password-store.ts, rules in
 * ./admin-guards.ts. Each action is logged (actor, action, target, changed
 * fields) without any password or hash.
 */
import { Hono, type Context } from 'hono';

import { pool, withTransaction } from '../core/db';
import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { HttpError } from '../core/validate';
import {
  adminUsersCreate,
  adminUsersDelete,
  adminUsersList,
  adminUsersResetPassword,
  adminUsersUpdate,
  type AdminUser,
} from '@shared/contracts/user/admin-users';
import { ADMIN_REFUSAL_MESSAGES, adminChangeRefusal } from './admin-guards';
import {
  actorStillAdmin,
  getManagedUser,
  isReservedEmail,
  insertUser,
  listManagedUsers,
  lockAdminGuard,
  otherActiveAdmins,
  removeUserRow,
  updateUserFields,
  userDataReferences,
} from './admin-users-store';
import { passwordLoginEnabled } from './config';
import { requireAdmin, requireFirstPartySession } from './middleware';
import { generateTempPassword, hashPassword, TEMP_PASSWORD_TTL_DAYS } from './password';
import { clearThrottle, revokePasswordGrants, setPassword } from './password-store';
import { noStore, originGuard, type TrustedOrigins } from './request-guards';
import type { IdentityUser } from './types';

const notFound = () => new HttpError(404, 'user not found');

function actor(c: Context): IdentityUser {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized');
  return user;
}

function audit(c: Context, action: string, target: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: 'admin_user_action', actor: actor(c).email, action, target, ...details }));
}

function requirePasswordLogin(): void {
  if (!passwordLoginEnabled()) throw new HttpError(409, 'password sign-in is turned off', 'password_login_disabled');
}

/** Inside the transaction: the caller must still be an active admin (403 otherwise). */
async function recheckActor(tx: Parameters<typeof actorStillAdmin>[0], actorId: string): Promise<void> {
  if (!(await actorStillAdmin(tx, actorId))) throw new HttpError(403, 'forbidden');
}

const tempExpiry = () => new Date(Date.now() + TEMP_PASSWORD_TTL_DAYS * 86_400_000);

async function mustGet(id: string): Promise<AdminUser> {
  const user = await getManagedUser(pool, id);
  if (!user) throw notFound();
  return user;
}

export const operations: readonly AnyOperation[] = [
  implement(adminUsersList, () => listManagedUsers(pool)),

  implement(adminUsersCreate, async (c, { email, name, role }) => {
    requirePasswordLogin();
    // The service and dev rows are the app's own: an admin can never create
    // them (the service token resolves to the service row by e-mail).
    if (isReservedEmail(email)) throw new HttpError(400, 'this e-mail is reserved', 'invalid_input');
    const me = actor(c);
    const temp = generateTempPassword();
    const hash = await hashPassword(temp);
    const id = await withTransaction(pool, async (tx) => {
      await lockAdminGuard(tx);
      await recheckActor(tx, me.id);
      const newId = await insertUser(tx, email, name ?? null, role ?? 'user');
      if (!newId) return null;
      await setPassword(tx, newId, hash, { mustChange: true, tempExpiresAt: tempExpiry() });
      await clearThrottle(tx, email);
      return newId;
    });
    if (!id) throw new HttpError(409, 'a user with this e-mail already exists', 'user_exists');
    audit(c, 'create', email, { role: role ?? 'user' });
    return { user: await mustGet(id), temp_password: temp };
  }),

  implement(adminUsersUpdate, async (c, { id, name, role, status }) => {
    const me = actor(c);
    const changed = await withTransaction(pool, async (tx) => {
      await lockAdminGuard(tx);
      await recheckActor(tx, me.id);
      const target = await getManagedUser(tx, id, true);
      if (!target) throw notFound();
      const refusal = adminChangeRefusal({
        actorId: me.id,
        target,
        change: { role, status },
        otherActiveAdmins: await otherActiveAdmins(tx, id),
      });
      if (refusal) throw new HttpError(409, ADMIN_REFUSAL_MESSAGES[refusal], refusal);
      await updateUserFields(tx, id, { name, role, status });
      return target.email;
    });
    audit(c, 'update', changed, {
      fields: Object.entries({ name, role, status })
        .filter(([, v]) => v !== undefined)
        .map(([k]) => k),
      ...(role !== undefined ? { role } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    return mustGet(id);
  }),

  implement(adminUsersResetPassword, async (c, { id }) => {
    requirePasswordLogin();
    const me = actor(c);
    const temp = generateTempPassword();
    const hash = await hashPassword(temp);
    const target = await withTransaction(pool, async (tx) => {
      await lockAdminGuard(tx);
      await recheckActor(tx, me.id);
      const t = await getManagedUser(tx, id, true);
      if (!t) throw notFound();
      // Bumps session_version: every password session of the user ends.
      await setPassword(tx, id, hash, { mustChange: true, tempExpiresAt: tempExpiry() });
      await revokePasswordGrants(tx, id);
      await clearThrottle(tx, t.email);
      return t;
    });
    audit(c, 'reset_password', target.email);
    return { user: await mustGet(id), temp_password: temp };
  }),

  implement(adminUsersDelete, async (c, { id }) => {
    const me = actor(c);
    const email = await withTransaction(pool, async (tx) => {
      await lockAdminGuard(tx);
      await recheckActor(tx, me.id);
      // Locks the row: referencing inserts wait, then fail, never cascade away unseen.
      const target = await getManagedUser(tx, id, true);
      if (!target) throw notFound();
      const refusal = adminChangeRefusal({ actorId: me.id, target, change: 'delete', otherActiveAdmins: await otherActiveAdmins(tx, id) });
      if (refusal) throw new HttpError(409, ADMIN_REFUSAL_MESSAGES[refusal], refusal);
      const refs = await userDataReferences(tx, id);
      if (refs.length > 0) throw new HttpError(409, 'this user has data; disable them instead', 'user_has_data');
      await removeUserRow(tx, id);
      await clearThrottle(tx, target.email);
      return target.email;
    });
    audit(c, 'delete', email);
    return undefined;
  }),
];

/** Post-gate router (mount after authMiddleware + requireUser). */
export function adminUsersRoutes(options: { trustedOrigins?: TrustedOrigins } = {}): Hono {
  const router = new Hono();
  mountOperations(router, operations, {
    use: [noStore, originGuard(options.trustedOrigins), requireFirstPartySession, requireAdmin],
  });
  return router;
}
