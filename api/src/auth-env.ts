/**
 * Entrypoint helper: builds the injected `AuthConfig` from an env record and
 * decides whether the process may boot. This is the only place auth env vars
 * are interpreted; features receive the resulting object (user/config.ts).
 *
 * Empty-string env values count as unset (a blank `FOO=` line in a secret
 * store must not look configured).
 */
import { DEFAULT_AUTH_CONFIG, type AuthConfig } from './user/config';

type Env = Record<string, string | undefined>;

/** Value of `k`, trimmed; empty = unset. */
const val = (e: Env, k: string): string | undefined => {
  const v = e[k]?.trim();
  return v ? v : undefined;
};

const splitList = (s: string | undefined): string[] =>
  (s ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);

/** True when any auth env is present (Google client or allow-list). */
function anyAuthConfigured(e: Env): boolean {
  return !!(val(e, 'GOOGLE_CLIENT_ID') || val(e, 'AUTH_ALLOWED_EMAILS'));
}

/** Auth is bypassed only on an explicit opt-in AND with no auth env present. */
export function authDisabledFromEnv(e: Env): boolean {
  return val(e, 'AUTH_DISABLED_OK') === '1' && !anyAuthConfigured(e);
}

/**
 * Fail-closed startup validation: a list of fatal misconfigurations.
 *
 * - Auth must be fully configured (allow-list, Google client id+secret, a
 *   >= 32 char SESSION_SECRET) unless `AUTH_DISABLED_OK=1` deliberately asks
 *   for auth-off local dev. Without the opt-in an unconfigured process refuses
 *   to boot, so a failed secret injection can never leave the API open.
 * - In a cluster (KUBERNETES_SERVICE_HOST) the opt-in is itself refused.
 * - With the opt-in and no auth env, boot is allowed (auth off). With the
 *   opt-in AND auth env present, the full rules apply (auth stays on).
 */
export function checkAuthEnv(e: Env): string[] {
  const errors: string[] = [];
  const inCluster = !!val(e, 'KUBERNETES_SERVICE_HOST');
  const optIn = val(e, 'AUTH_DISABLED_OK') === '1';

  if (optIn && inCluster) {
    errors.push('AUTH_DISABLED_OK=1 is not allowed in a cluster');
  }
  if (optIn && !anyAuthConfigured(e)) return errors;

  const secret = val(e, 'SESSION_SECRET');
  const where = inCluster ? ' in a cluster' : '';
  if (!val(e, 'AUTH_ALLOWED_EMAILS')) errors.push(`AUTH_ALLOWED_EMAILS must be set${where || ' (or AUTH_DISABLED_OK=1 for local dev)'}`);
  if (!val(e, 'GOOGLE_CLIENT_ID')) errors.push(`GOOGLE_CLIENT_ID must be set${where || ' (or AUTH_DISABLED_OK=1 for local dev)'}`);
  if (!val(e, 'GOOGLE_CLIENT_SECRET')) errors.push(`GOOGLE_CLIENT_SECRET must be set${where || ' (or AUTH_DISABLED_OK=1 for local dev)'}`);
  if (!secret || secret.length < 32) errors.push('SESSION_SECRET must be set and >= 32 chars');
  return errors;
}

/** Abort boot on fatal auth misconfiguration (call once at startup). */
export function assertAuthEnv(e: Env): void {
  const errors = checkAuthEnv(e);
  if (errors.length > 0) {
    console.error('FATAL: auth misconfiguration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
}

/** Build the injected config. Call after `assertAuthEnv`. */
export function authConfigFromEnv(e: Env): AuthConfig {
  const d = DEFAULT_AUTH_CONFIG;
  const ttl = Number(val(e, 'SESSION_TTL_DAYS') ?? d.sessionTtlDays);
  return {
    authDisabled: authDisabledFromEnv(e),
    sessionSecret: val(e, 'SESSION_SECRET') ?? '',
    cookieName: d.cookieName,
    cookieDomain: val(e, 'COOKIE_DOMAIN') ?? d.cookieDomain,
    sessionTtlDays: Number.isFinite(ttl) && ttl > 0 ? ttl : d.sessionTtlDays,
    appOrigin: val(e, 'APP_BASE_URL') ?? d.appOrigin,
    apiBaseUrl: val(e, 'API_BASE_URL') ?? d.apiBaseUrl,
    allowedEmails: splitList(val(e, 'AUTH_ALLOWED_EMAILS')),
    googleClientId: val(e, 'GOOGLE_CLIENT_ID') ?? '',
    googleClientSecret: val(e, 'GOOGLE_CLIENT_SECRET') ?? '',
    nativeRedirectSchemes: d.nativeRedirectSchemes,
    serviceToken: val(e, 'OT_SERVICE_TOKEN') ?? '',
  };
}
