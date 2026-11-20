/**
 * The per-request session rule: may this principal hold a session right now?
 * Every place that turns a session or an OAuth grant into a principal calls
 * {@link admitSession} or {@link admitGrant} (currentUser, cookieSessionUser,
 * accessPrincipal and the consent POST in oauth/authorize.ts); the
 * principal's user row is then resolved by {@link resolvePrincipalUser},
 * which never creates a row for a password principal.
 *
 * Rule ({@link decideSession}, pure):
 *  - idp `password`: password login is on, the user exists and is active, it
 *    has a password row and (sessions only) the token's `pwv` equals the
 *    row's session_version. Config allow-lists do not apply.
 *  - otherwise, on the config rule (`isAllowed`: the Google list, or an
 *    Access session while Access is on): yes, with no DB read (unchanged).
 *  - an unmarked (Google) session or grant that fails the config rule: yes
 *    only for an admin-managed user (has a password row) who is active, while
 *    password login is on (Google linking).
 *  - anything else: no.
 * A disabled user is still refused for every idp by requireUser (status).
 */
import { pool } from '../core/db';
import { isAllowed, passwordLoginEnabled } from './config';
import { findSessionUser, sessionAccountState, type SessionAccountState } from './password-store';
import { resolveOrCreateSessionUser } from './store';
import type { IdentityUser } from './types';

export interface SessionFacts {
  idp?: string | null;
  /** Password session version claim; undefined for grants (not checked). */
  pwv?: number;
  /** isAllowed(email, idp): the config-only rule. */
  onConfigRule: boolean;
  passwordLogin: boolean;
  /** DB state; undefined = not loaded (only needed when the config rule fails or idp is password). */
  account?: SessionAccountState | null;
}

/** The pure rule (see the module comment). */
export function decideSession(f: SessionFacts): boolean {
  const managedActive = !!f.account && f.account.status === 'active' && f.account.passwordVersion !== null;
  if (f.idp === 'password') {
    if (!f.passwordLogin || !managedActive) return false;
    return f.pwv === undefined || f.pwv === f.account!.passwordVersion;
  }
  if (f.onConfigRule) return true;
  if (!f.idp) return f.passwordLogin && managedActive;
  return false;
}

async function admit(email: string, idp: string | null | undefined, pwv: number | undefined): Promise<boolean> {
  const onConfigRule = idp !== 'password' && isAllowed(email, idp);
  const passwordLogin = passwordLoginEnabled();
  const facts: SessionFacts = { idp, pwv, onConfigRule, passwordLogin };
  // Only read the DB when the answer depends on it (keeps Google/Access hot path unchanged).
  if (!onConfigRule && passwordLogin && (idp === 'password' || !idp)) {
    facts.account = await sessionAccountState(pool, email);
  }
  return decideSession(facts);
}

/** A session (cookie or Bearer). Password sessions must carry their version. */
export function admitSession(claims: { email: string; idp?: string; pwv?: number }): Promise<boolean> {
  if (claims.idp === 'password' && claims.pwv === undefined) return Promise.resolve(false);
  return admit(claims.email, claims.idp, claims.idp === 'password' ? claims.pwv : undefined);
}

/** An OAuth grant, judged by how its approver signed in (no version: grants are revoked instead). */
export function admitGrant(email: string, idp: string | null | undefined): Promise<boolean> {
  return admit(email, idp, undefined);
}

/**
 * Google sign-in (web callback and native /auth/token): the e-mail is on the
 * Google list, or it belongs to an active admin-managed user while password
 * login is on. `email_verified` is checked by the caller first.
 */
export async function googleSignInAllowed(email: string, googleAllowed: (e: string) => boolean): Promise<boolean> {
  if (googleAllowed(email)) return true;
  if (!passwordLoginEnabled()) return false;
  return decideSession({ idp: null, onConfigRule: false, passwordLogin: true, account: await sessionAccountState(pool, email) });
}

/**
 * The DB-authoritative row for an admitted principal. Password principals
 * (sessions, and grants approved from one) never create a row: a row deleted
 * meanwhile is null (401). Everyone else keeps resolveOrCreateSessionUser.
 */
export function resolvePrincipalUser(principal: { email: string; idp?: string | null }): Promise<IdentityUser | null> {
  if (principal.idp === 'password') return findSessionUser(pool, principal.email);
  return resolveOrCreateSessionUser(principal.email);
}
