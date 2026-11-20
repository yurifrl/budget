/**
 * Admin user-management guards (pure).
 *
 * - An admin cannot disable, demote or delete themself (renaming is fine).
 * - The last ACTIVE admin cannot be disabled, demoted or deleted, by anyone.
 */
import type { IdentityRole, IdentityStatus } from './types';

export type AdminChangeRefusal = 'cannot_modify_self' | 'last_admin';

export interface AdminChange {
  actorId: string;
  target: { id: string; role: IdentityRole; status: IdentityStatus };
  /** The change: a role/status patch, or a delete. */
  change: { role?: IdentityRole; status?: IdentityStatus } | 'delete';
  /** Active admins other than the target. */
  otherActiveAdmins: number;
}

/** Why the change is refused; null = allowed. */
export function adminChangeRefusal(a: AdminChange): AdminChangeRefusal | null {
  const deleting = a.change === 'delete';
  const nextRole = deleting ? undefined : ((a.change as { role?: IdentityRole }).role ?? a.target.role);
  const nextStatus = deleting ? undefined : ((a.change as { status?: IdentityStatus }).status ?? a.target.status);
  const disables = !deleting && a.target.status === 'active' && nextStatus === 'disabled';
  const demotes = !deleting && a.target.role === 'admin' && nextRole === 'user';
  if (a.actorId === a.target.id && (deleting || disables || demotes)) return 'cannot_modify_self';
  const isActiveAdmin = a.target.role === 'admin' && a.target.status === 'active';
  if (isActiveAdmin && (deleting || disables || demotes) && a.otherActiveAdmins === 0) return 'last_admin';
  return null;
}

export const ADMIN_REFUSAL_MESSAGES: Readonly<Record<AdminChangeRefusal, string>> = {
  cannot_modify_self: 'you cannot disable, demote or delete yourself',
  last_admin: 'the last active admin cannot be disabled, demoted or deleted',
};
