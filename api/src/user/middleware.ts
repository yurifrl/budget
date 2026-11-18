import type { Context, MiddlewareHandler } from 'hono';

import { authDisabled, currentUser } from './authz';

import { ensureDevAdminRole, resolveOrCreateSessionUser, resolveServiceUser } from './store';
import { HttpError } from '../core/validate';
import type { IdentityUser } from './types';

export const DEV_EMAIL = 'dev@localhost';
const DEV_SUB = 'dev:local';

/**
 * Sole post-gate authority resolver (D-05). Reads the session principal
 * captured by authMiddleware, the service bearer lane, or — when auth is
 * fully unconfigured (local dev) — the dev bypass, and attaches the
 * DB-authoritative identity to the context. Roles and status are read from
 * the DB on every request (criterion 2): never memoized, so a DB-side
 * demotion or disable is observable on the next request without restart.
 */
export const requireUser: MiddlewareHandler = async (c, next) => {
  const principal = c.get('principal');
  let user;
  if (principal) {
    // Old cookies carry no sub (JWT shape frozen per D-01): per-request
    // callers pass no identity, so any stored google_sub stays untouched.
    user = await resolveOrCreateSessionUser(principal.email);
  } else if (authDisabled()) {
    // Dev bypass: provision exactly one persisted synthetic admin. The
    // bypassed machine has no other authority, so its row is idempotently
    // promoted to admin in every dev-DB state (criterion 3).
    const dev = await resolveOrCreateSessionUser(DEV_EMAIL, { sub: DEV_SUB }, { seedEligible: true });
    if (dev.role !== 'admin') {
      await ensureDevAdminRole(dev.id);
      user = { ...dev, role: 'admin' as const };
    } else {
      user = dev;
    }
  } else {
    // Service bearer (MCP/CLI) — the sole bearer authority post-gate.
    user = await resolveServiceUser(c);
  }
  const rejected = rejectUnlessActive(c, user);
  if (rejected) return rejected;
  c.set('user', user as IdentityUser);
  await next();
};

/**
 * The one definition of "may this resolved principal proceed": no user → 401
 * `unauthorized`; a disabled row → 401 `account disabled` (D-04) — the session
 * JWT itself stays valid. Returns the rejection response, or null to proceed.
 */
function rejectUnlessActive(c: Context, user: IdentityUser | null | undefined): Response | null {
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.status !== 'active') return c.json({ error: 'account disabled' }, 401);
  return null;
}

/**
 * Session lane for routes mounted BEFORE the gate that authenticate on their
 * own (service token / ticket minting). Resolves the session principal to its
 * DB-authoritative row and applies the same status check as requireUser.
 * Returns the rejection response, or null when the session user is active.
 */
export async function rejectUnlessActiveSession(c: Context): Promise<Response | null> {
  const claims = await currentUser(c);
  const user = claims ? await resolveOrCreateSessionUser(claims.email) : null;
  return rejectUnlessActive(c, user);
}

/**
 * Admin gate. Requires requireUser to have run first in the chain: missing
 * identity → 401, non-admin role → 403 `forbidden` (criterion 2).
 */
export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get('user');
  if (!user) return c.json({ error: 'unauthorized' }, 401);
  if (user.role !== 'admin') return c.json({ error: 'forbidden' }, 403);
  await next();
};

/** Session-scoped user id for feature routes. requireUser guarantees a
 *  resolved identity; the 401 is a pure safety net (throws so handlers can
 *  treat the result as a plain string). */
export function requireUserId(c: Context): string {
  const user = c.get('user');
  if (!user) throw new HttpError(401, 'unauthorized');
  return user.id;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Own-identity writes (name, picture) are first-party only: an OAuth access
 * token (principal carries a `scope`) may read but never mutate the user's
 * profile, even with the `write` scope that grants budget writes. Sessions,
 * the service lane and the dev bypass carry no scope and pass.
 */
export const forbidOAuthWrites: MiddlewareHandler = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method) && c.get('principal')?.scope !== undefined) {
    return c.json({ error: 'forbidden' }, 403);
  }
  await next();
};
