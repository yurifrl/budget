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

/** Comma-separated tags, case kept (AUD tags are compared exactly). */
const splitTags = (s: string | undefined): string[] =>
  (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const AUTH_VARS = ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'AUTH_ALLOWED_EMAILS', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'];

/** True when any auth env is present (a provider's settings or the allow-list). */
function anyAuthConfigured(e: Env): boolean {
  return AUTH_VARS.some((k) => !!val(e, k));
}

/** Auth is bypassed only on an explicit opt-in AND with no auth env present. */
export function authDisabledFromEnv(e: Env): boolean {
  return val(e, 'AUTH_DISABLED_OK') === '1' && !anyAuthConfigured(e);
}

/** A bare hostname like `team.cloudflareaccess.com` (no scheme, path or port). */
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

/**
 * Fail-closed startup validation: a list of fatal misconfigurations.
 *
 * - At least one sign-in provider must be fully configured, plus a >= 32 char
 *   SESSION_SECRET, unless `AUTH_DISABLED_OK=1` deliberately asks for
 *   auth-off local dev:
 *     Cloudflare Access = ACCESS_TEAM_DOMAIN + ACCESS_AUD (who may sign in is
 *       the Cloudflare policy's call alone; AUTH_ALLOWED_EMAILS does not
 *       apply to Access sign-ins);
 *     Google = GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + AUTH_ALLOWED_EMAILS.
 *   A half-configured provider is itself an error, even when the other one is
 *   complete (a typo must not silently switch a provider off).
 * - Without the opt-in an unconfigured process refuses to boot, so a failed
 *   secret injection can never leave the API open.
 * - In a cluster (KUBERNETES_SERVICE_HOST) the opt-in is refused, and so is
 *   ACCESS_CERTS_URL (a dev/test JWKS override).
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
  if (inCluster && val(e, 'ACCESS_CERTS_URL')) {
    errors.push('ACCESS_CERTS_URL (dev/test JWKS override) is not allowed in a cluster');
  }
  if (optIn && !anyAuthConfigured(e)) return errors;

  const where = inCluster ? ' in a cluster' : ' (or AUTH_DISABLED_OK=1 for local dev)';
  const team = val(e, 'ACCESS_TEAM_DOMAIN');
  const aud = splitTags(val(e, 'ACCESS_AUD'));
  const accessAny = !!team || aud.length > 0;
  const accessFull = !!team && aud.length > 0;
  const gid = val(e, 'GOOGLE_CLIENT_ID');
  const gsec = val(e, 'GOOGLE_CLIENT_SECRET');
  const list = val(e, 'AUTH_ALLOWED_EMAILS');
  const googleAny = !!gid || !!gsec;

  if (accessAny && !team) errors.push('ACCESS_TEAM_DOMAIN must be set when ACCESS_AUD is');
  if (accessAny && aud.length === 0) errors.push('ACCESS_AUD must be set when ACCESS_TEAM_DOMAIN is');
  if (team && !HOSTNAME.test(team)) errors.push('ACCESS_TEAM_DOMAIN must be a bare hostname like team.cloudflareaccess.com');

  if (googleAny) {
    if (!gid) errors.push('GOOGLE_CLIENT_ID must be set when GOOGLE_CLIENT_SECRET is');
    if (!gsec) errors.push('GOOGLE_CLIENT_SECRET must be set when GOOGLE_CLIENT_ID is');
    if (!list) errors.push(`AUTH_ALLOWED_EMAILS must be set for Google sign-in${where}`);
  } else if (!accessFull && !accessAny) {
    errors.push(
      `no sign-in provider${where}: set ACCESS_TEAM_DOMAIN + ACCESS_AUD (Cloudflare Access) or ` +
        'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET + AUTH_ALLOWED_EMAILS (Google)',
    );
  }
  const secret = val(e, 'SESSION_SECRET');
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
    accessTeamDomain: (val(e, 'ACCESS_TEAM_DOMAIN') ?? '').toLowerCase(),
    accessAud: splitTags(val(e, 'ACCESS_AUD')),
    // Dev/test only; checkAuthEnv refuses it in a cluster (belt and braces here).
    accessCertsUrl: val(e, 'KUBERNETES_SERVICE_HOST') ? '' : (val(e, 'ACCESS_CERTS_URL') ?? ''),
  };
}
