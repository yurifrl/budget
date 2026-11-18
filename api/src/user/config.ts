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
  /** Lower-cased e-mails allowed to sign in. */
  allowedEmails: string[];
  googleClientId: string;
  googleClientSecret: string;
  /** URL prefixes a native app may be redirected to after sign-in, e.g. `budgetapp://`. */
  nativeRedirectSchemes: string[];
  /** Machine-to-machine bearer for agent clients; empty = lane disabled. */
  serviceToken: string;
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
};

let current: AuthConfig = DEFAULT_AUTH_CONFIG;

/** Install the config (entrypoints call this once; tests call it per case). */
export function configureAuth(config: Partial<AuthConfig>): AuthConfig {
  current = { ...DEFAULT_AUTH_CONFIG, ...config };
  return current;
}

export const authConfig = (): AuthConfig => current;
