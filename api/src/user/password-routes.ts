/**
 * E-mail + password sign-in (docs/decisions.md, "Password sign-in and user
 * management"). Handlers only parse, decide and shape the response: SQL is in
 * ./password-store.ts, hashing and tokens in ./password.ts, throttle rules in
 * ./throttle.ts, the per-request session rule in ./session-gate.ts.
 *
 *   POST /auth/password/login     pre-gate
 *   POST /auth/password/complete  pre-gate (change token from login)
 *   POST /auth/password/change    post-gate (first-party session)
 *
 * All three answer 404 while password login is off.
 */
import { Hono, type Context, type MiddlewareHandler } from 'hono';

import { pool, withTransaction } from '../core/db';
import { implement, mountOperations, type AnyOperation } from '../core/operation';
import { errorResponse, HttpError } from '../core/validate';
import { authPasswordChange, authPasswordComplete, authPasswordLogin, type SessionDelivery } from '@shared/contracts/user/password';
import { PASSWORD_REJECTION_MESSAGES, passwordRejection, type PasswordRejection } from '@shared/password-policy';
import { passwordLoginEnabled } from './config';
import { requireFirstPartySession } from './middleware';
import {
  CHANGE_TOKEN_TTL_SECONDS,
  hashPassword,
  mintChangeToken,
  verifyChangeToken,
  verifyDummy,
  verifyPassword,
  warmDummyHash,
} from './password';
import {
  clearThrottle,
  findPasswordAccount,
  replacePasswordIfVersion,
  reserveAttempt,
  revokePasswordGrants,
  stampSignIn,
} from './password-store';
import { clientAddress, noStore, originGuard, requireJsonBody, type TrustedOrigins } from './request-guards';
import { mintSessionToken, setSessionCookie } from './session-cookie';
import { reserveIpAttempt, retryAfterSeconds } from './throttle';

export interface PasswordRouteOptions {
  /** Browser origins allowed to call these routes (the CORS list). */
  trustedOrigins?: TrustedOrigins;
}

const passwordOff: MiddlewareHandler = async (c, next) => {
  if (!passwordLoginEnabled()) return errorResponse(c, 404, 'not found');
  await next();
};

const invalidCredentials = () => new HttpError(401, 'invalid e-mail or password', 'invalid_credentials');

function tooManyAttempts(c: Context, seconds: number): Response {
  c.header('Retry-After', String(seconds));
  return errorResponse(c, 429, 'too many attempts, try again later', 'too_many_attempts');
}

function rejectPassword(code: PasswordRejection): never {
  throw new HttpError(400, PASSWORD_REJECTION_MESSAGES[code], code);
}

/** Policy for a chosen password; `previousHash` = the current/temporary one it must differ from. */
async function checkNewPassword(password: string, email: string, previousHash: string): Promise<void> {
  const rejection = passwordRejection(password, email);
  if (rejection) rejectPassword(rejection);
  if (await verifyPassword(password, previousHash)) rejectPassword('password_unchanged');
}

/** Hand over a password session: cookie (web) or token in the body (native). */
async function signIn(c: Context, email: string, version: number, delivery: SessionDelivery | undefined) {
  if (delivery === 'token') return { status: 'signed_in' as const, email, token: await mintSessionToken(email, 'password', version) };
  await setSessionCookie(c, email, 'password', version);
  return { status: 'signed_in' as const, email };
}

/**
 * Reserve the attempt (address, then e-mail) BEFORE any verification; a
 * refusal is a 429 and runs no argon2 at all. Returns the 429 or null.
 */
async function reserve(c: Context, email: string | null): Promise<Response | null> {
  const ipWait = reserveIpAttempt(clientAddress(c));
  if (ipWait > 0) return tooManyAttempts(c, ipWait);
  if (email === null) return null;
  const r = await reserveAttempt(pool, email);
  return r.allowed ? null : tooManyAttempts(c, Math.max(1, retryAfterSeconds(r.lockedUntil)));
}

export const passwordSignInOperations: readonly AnyOperation[] = [
  implement(authPasswordLogin, async (c, { email, password, session }) => {
    // Unknown e-mails are reserved and locked exactly like real ones.
    const refused = await reserve(c, email);
    if (refused) return refused;

    const account = await findPasswordAccount(pool, email);
    // Exactly one argon2 verification on every admitted path (dummy when nothing to check).
    const ok = account?.password ? await verifyPassword(password, account.password.hash) : await verifyDummy(password);
    // The attempt is already counted: a failure writes nothing more.
    if (!ok || !account?.password || account.status !== 'active') throw invalidCredentials();

    const pw = account.password;
    if (pw.mustChange) {
      // Only now (the temporary password was right) may we say it expired.
      if (pw.tempExpiresAt && pw.tempExpiresAt.getTime() <= Date.now()) {
        throw new HttpError(401, 'temporary password expired, ask an admin for a new one', 'temp_password_expired');
      }
      await clearThrottle(pool, account.email);
      return {
        status: 'password_change_required' as const,
        email: account.email,
        change_token: await mintChangeToken({ email: account.email, userId: account.userId, pwv: pw.version }),
        expires_in: CHANGE_TOKEN_TTL_SECONDS,
      };
    }
    await clearThrottle(pool, account.email);
    await stampSignIn(pool, account.userId);
    return signIn(c, account.email, pw.version, session);
  }),

  implement(authPasswordComplete, async (c, { change_token, new_password, session }) => {
    // The change token is the credential (signed, 10 minutes, single use), so
    // only the address budget applies here; it is reserved before any argon2.
    const refused = await reserve(c, null);
    if (refused) return refused;
    const invalidToken = () => new HttpError(401, 'sign-in expired, start again', 'invalid_change_token');
    const claims = await verifyChangeToken(change_token);
    if (!claims) throw invalidToken();
    const account = await findPasswordAccount(pool, claims.email);
    const pw = account?.password;
    if (!account || !pw || account.userId !== claims.userId || account.status !== 'active' || !pw.mustChange || pw.version !== claims.pwv) {
      throw invalidToken();
    }
    if (pw.tempExpiresAt && pw.tempExpiresAt.getTime() <= Date.now()) {
      throw new HttpError(401, 'temporary password expired, ask an admin for a new one', 'temp_password_expired');
    }
    await checkNewPassword(new_password, account.email, pw.hash);
    const hash = await hashPassword(new_password);
    const version = await withTransaction(pool, async (tx) => {
      const v = await replacePasswordIfVersion(tx, account.userId, claims.pwv, hash, true);
      if (v === null) return null;
      await revokePasswordGrants(tx, account.userId);
      await clearThrottle(tx, account.email);
      await stampSignIn(tx, account.userId);
      return v;
    });
    // Lost a race with another completion or an admin reset: the token is spent.
    if (version === null) throw invalidToken();
    return signIn(c, account.email, version, session);
  }),
];

export const passwordChangeOperations: readonly AnyOperation[] = [
  implement(authPasswordChange, async (c, { current_password, new_password }) => {
    const user = c.get('user');
    const principal = c.get('principal');
    if (!user || !principal) throw new HttpError(403, 'forbidden');
    const account = await findPasswordAccount(pool, user.email);
    const pw = account?.password;
    if (!account || !pw) throw new HttpError(400, 'this account has no password', 'no_password');
    // Same budget as login, reserved before verifying the current password.
    const refused = await reserve(c, account.email);
    if (refused) return refused;
    if (!(await verifyPassword(current_password, pw.hash))) throw invalidCredentials();
    // The current password was right: forget the count before the policy check.
    await clearThrottle(pool, account.email);
    await checkNewPassword(new_password, account.email, pw.hash);
    const hash = await hashPassword(new_password);
    const version = await withTransaction(pool, async (tx) => {
      const v = await replacePasswordIfVersion(tx, account.userId, pw.version, hash, false);
      if (v === null) return null;
      await revokePasswordGrants(tx, account.userId);
      return v;
    });
    if (version === null) throw new HttpError(409, 'the password changed meanwhile, try again', 'conflict');

    // Other password sessions die with the version bump; re-issue this one.
    if (principal.idp !== 'password') return { ok: true as const };
    const auth = c.req.header('Authorization');
    if (auth?.startsWith('Bearer ')) return { ok: true as const, token: await mintSessionToken(account.email, 'password', version) };
    await setSessionCookie(c, account.email, 'password', version);
    return { ok: true as const };
  }),
];

/** Pre-gate: login + complete, on the app itself (called by mountAuthRoutes). */
export function mountPasswordRoutes(app: Hono, options: PasswordRouteOptions = {}): void {
  if (passwordLoginEnabled()) warmDummyHash();
  mountOperations(app, passwordSignInOperations, {
    use: [passwordOff, noStore, originGuard(options.trustedOrigins), requireJsonBody],
  });
}

/** Post-gate router: change password (mount after authMiddleware + requireUser). */
export function passwordChangeRoutes(options: PasswordRouteOptions = {}): Hono {
  const router = new Hono();
  mountOperations(router, passwordChangeOperations, {
    use: [passwordOff, noStore, originGuard(options.trustedOrigins), requireFirstPartySession, requireJsonBody],
  });
  return router;
}
