/**
 * Auth configuration, injected once by the entrypoint (index.ts builds it from
 * env in `auth-env.ts`). Features never read `process.env`: everything the
 * identity layer needs (cookie, origins, allow-list, Google client, session
 * secret, native redirect schemes) lives in this object.
 *
 * The default is fail-closed: no allow-list and no secret mean every request
 * is refused. Auth-off local dev is an explicit `authDisabled: true`, which
 * the entrypoint only grants when `AUTH_DISABLED_OK=1` and nothing else about
 * auth is configured.
 */

export interface AuthConfig {
  /** Auth bypass (local dev only). Set by the entrypoint, never derived. */
  authDisabled: boolean;
  /** HMAC key for session JWTs and OAuth tokens (>= 32 chars when auth is on). */
  sessionSecret: string;
  /** Session cookie name. Must differ from syscd's (both live under .syscd.live). */
  cookieName: string;
  cookieDomain: string;
  sessionTtlDays: number;
  /** Web app origin (post-login redirect target). */
  appOrigin: string;
  /** Public API origin (OAuth issuer, Google redirect URIs). */
  apiBaseUrl: string;
  /**
   * Lower-cased e-mails allowed to sign in WITH GOOGLE (AUTH_ALLOWED_EMAILS).
   * Cloudflare Access sign-ins are not checked against it: the Access policy
   * is their gate.
   */
  allowedEmails: string[];
  googleClientId: string;
  googleClientSecret: string;
  /** URL prefixes a native app may be redirected to after sign-in, e.g. `budgetapp://`. */
  nativeRedirectSchemes: string[];
  /** Machine-to-machine bearer for agent clients; empty = lane disabled. */
  serviceToken: string;
  /**
   * Cloudflare Access team domain (`<team>.cloudflareaccess.com`, no scheme).
   * With `accessAud` non-empty, Access is a sign-in provider (/auth/access).
   */
  accessTeamDomain: string;
  /** AUD tags of the Access applications whose assertions are accepted. */
  accessAud: string[];
  /**
   * JWKS URL override for local dev and tests (a fake signer). '' = the team's
   * real `/cdn-cgi/access/certs`. The entrypoint refuses it in a cluster.
   */
  accessCertsUrl: string;
  /** fetch used for the JWKS (tests inject a fake); undefined = global fetch. */
  accessFetch?: typeof fetch;
  /**
   * E-mail + password sign-in (AUTH_PASSWORD_LOGIN, default on). Effective
   * only while auth is on: see `passwordLoginEnabled`. Off = the password
   * routes answer 404, every password session is refused and admin-managed
   * e-mails get no Google exception.
   */
  passwordLogin: boolean;
  /**
   * argon2id cost for NEW hashes. Never read from env: production always uses
   * the default (Bun's argon2id, 64 MiB, t=2). Tests lower it to stay fast;
   * verification always uses the parameters stored in the hash.
   */
  passwordHashCost?: { memoryCost: number; timeCost: number };
}

export const DEFAULT_AUTH_CONFIG: AuthConfig = {
  authDisabled: false,
  sessionSecret: '',
  cookieName: 'budget_session',
  cookieDomain: '.syscd.live',
  sessionTtlDays: 30,
  appOrigin: 'https://budget.syscd.live',
  apiBaseUrl: 'https://budget-api.syscd.live',
  allowedEmails: [],
  googleClientId: '',
  googleClientSecret: '',
  nativeRedirectSchemes: ['exp://', 'budgetapp://'],
  serviceToken: '',
  accessTeamDomain: '',
  accessAud: [],
  accessCertsUrl: '',
  passwordLogin: true,
};

let current: AuthConfig = DEFAULT_AUTH_CONFIG;

/** Install the config (entrypoints call this once; tests call it per case). */
export function configureAuth(config: Partial<AuthConfig>): AuthConfig {
  current = { ...DEFAULT_AUTH_CONFIG, ...config };
  return current;
}

export const authConfig = (): AuthConfig => current;

/** Cloudflare Access sign-in is on: a team domain and at least one AUD tag. */
export const accessConfigured = (): boolean => !!current.accessTeamDomain && current.accessAud.length > 0;

/** Password sign-in is on: auth is on, a session secret exists and AUTH_PASSWORD_LOGIN is not 0. */
export const passwordLoginEnabled = (): boolean => !current.authDisabled && current.passwordLogin && current.sessionSecret.length > 0;

const normalizeEmail = (email: string): string => email.toLowerCase().trim();

/**
 * May this e-mail sign in with Google? Google is not behind Cloudflare Access
 * (anyone with a Google account reaches the callback), so it needs the
 * API-side list: no list = nobody.
 */
export function googleAllowed(email: string): boolean {
  const e = normalizeEmail(email);
  return !!e && current.allowedEmails.includes(e);
}

/**
 * May this e-mail hold a session (checked on every request, for sessions and
 * OAuth grants alike)? `idp` is how the session, or the session that approved
 * the grant, signed in.
 *
 * - `access`: the person passed the Cloudflare Access policy and the API
 *   verified the assertion. Access is the gate, so no API-side list applies;
 *   the session is good while Access stays configured (or the e-mail is on the
 *   Google list anyway).
 * - anything else (Google, or a session minted before the marker existed):
 *   with AUTH_ALLOWED_EMAILS set the e-mail must be on it; without a list only
 *   an Access deployment admits anyone (those are pre-marker Access sessions).
 *   No list and no Access = nobody (fail closed).
 */
export function isAllowed(email: string, idp?: string | null): boolean {
  const e = normalizeEmail(email);
  if (!e) return false;
  if (current.allowedEmails.includes(e)) return true;
  if (idp === 'access') return accessConfigured();
  return current.allowedEmails.length === 0 && accessConfigured();
}
