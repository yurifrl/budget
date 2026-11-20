import { describe, expect, it, test } from 'bun:test';

import { authConfigFromEnv, authDisabledFromEnv, checkAuthEnv, passwordLoginFromEnv } from './auth-env';

const SECRET = 'x'.repeat(32);
const FULL = {
  AUTH_ALLOWED_EMAILS: 'a@b.com, C@D.com',
  GOOGLE_CLIENT_ID: 'cid',
  GOOGLE_CLIENT_SECRET: 'csec',
  SESSION_SECRET: SECRET,
};

describe('checkAuthEnv (fail-closed startup guard)', () => {
  it('refuses to boot with no auth env and no explicit opt-in', () => {
    const errs = checkAuthEnv({});
    expect(errs.length).toBe(2);
    expect(errs.join('\n')).toContain('AUTH_DISABLED_OK=1');
    expect(errs.join('\n')).toContain('no sign-in provider');
  });

  it('allows auth-off boot only with AUTH_DISABLED_OK=1 and no auth env', () => {
    expect(checkAuthEnv({ AUTH_DISABLED_OK: '1' })).toEqual([]);
    expect(checkAuthEnv({ AUTH_DISABLED_OK: 'true' }).length).toBeGreaterThan(0);
  });

  it('treats empty-string values as unset', () => {
    expect(checkAuthEnv({ AUTH_DISABLED_OK: '1', GOOGLE_CLIENT_ID: '', AUTH_ALLOWED_EMAILS: '  ' })).toEqual([]);
    expect(checkAuthEnv({ ...FULL, SESSION_SECRET: '' })).toContain('SESSION_SECRET must be set and >= 32 chars');
    expect(checkAuthEnv({ ...FULL, GOOGLE_CLIENT_SECRET: '' }).some((e) => e.includes('GOOGLE_CLIENT_SECRET'))).toBe(true);
  });

  it('with the opt-in AND partial auth env, the full rules still apply', () => {
    const errs = checkAuthEnv({ AUTH_DISABLED_OK: '1', AUTH_ALLOWED_EMAILS: 'a@b.com' });
    expect(errs).toContain('SESSION_SECRET must be set and >= 32 chars');
  });

  it('requires a >=32 char SESSION_SECRET', () => {
    expect(checkAuthEnv({ ...FULL, SESSION_SECRET: 'short' })).toContain('SESSION_SECRET must be set and >= 32 chars');
    expect(checkAuthEnv(FULL)).toEqual([]);
  });

  it('refuses the opt-in in a cluster, and keeps the in-cluster full-config rule', () => {
    expect(checkAuthEnv({ KUBERNETES_SERVICE_HOST: '10.0.0.1', AUTH_DISABLED_OK: '1' })).toContain(
      'AUTH_DISABLED_OK=1 is not allowed in a cluster',
    );
    const errs = checkAuthEnv({ KUBERNETES_SERVICE_HOST: '10.0.0.1' });
    expect(errs.some((e) => e.includes('AUTH_ALLOWED_EMAILS'))).toBe(true);
    expect(errs.some((e) => e.includes('GOOGLE_CLIENT_ID'))).toBe(true);
    expect(checkAuthEnv({ KUBERNETES_SERVICE_HOST: '10.0.0.1', ...FULL })).toEqual([]);
  });
});

describe('authConfigFromEnv', () => {
  it('builds the injected config with Budget defaults', () => {
    const cfg = authConfigFromEnv(FULL);
    expect(cfg).toMatchObject({
      authDisabled: false,
      sessionSecret: SECRET,
      cookieName: 'budget_session',
      cookieDomain: '.syscd.live',
      appOrigin: 'https://budget.syscd.live',
      apiBaseUrl: 'https://budget-api.syscd.live',
      allowedEmails: ['a@b.com', 'c@d.com'],
      nativeRedirectSchemes: ['exp://', 'budgetapp://'],
      sessionTtlDays: 30,
    });
  });

  it('auth stays ON when AUTH_DISABLED_OK=1 is set next to real auth config', () => {
    expect(authDisabledFromEnv({ AUTH_DISABLED_OK: '1', ...FULL })).toBe(false);
    expect(authDisabledFromEnv({ AUTH_DISABLED_OK: '1' })).toBe(true);
    expect(authDisabledFromEnv({})).toBe(false);
  });

  it('honours overrides and ignores empty strings', () => {
    const cfg = authConfigFromEnv({ ...FULL, COOKIE_DOMAIN: '', APP_BASE_URL: 'http://localhost:8091', SESSION_TTL_DAYS: '7' });
    expect(cfg.cookieDomain).toBe('.syscd.live');
    expect(cfg.appOrigin).toBe('http://localhost:8091');
    expect(cfg.sessionTtlDays).toBe(7);
  });
});

describe('checkAuthEnv: provider matrix (Cloudflare Access / Google)', () => {
  const K8S = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };
  const ACCESS = { ACCESS_TEAM_DOMAIN: 'syscd.cloudflareaccess.com', ACCESS_AUD: 'aud-web, aud-native' };
  const GOOGLE = { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', AUTH_ALLOWED_EMAILS: 'a@b.com' };
  const S = { SESSION_SECRET: SECRET };

  const cases: [string, Record<string, string>, boolean][] = [
    ['Access only', { ...ACCESS, ...S }, true],
    ['Access only + allow-list', { ...ACCESS, AUTH_ALLOWED_EMAILS: 'a@b.com', ...S }, true],
    ['Google only', { ...GOOGLE, ...S }, true],
    ['both', { ...ACCESS, ...GOOGLE, ...S }, true],
    ['neither', { ...S }, false],
    ['only an allow-list', { AUTH_ALLOWED_EMAILS: 'a@b.com', ...S }, false],
    ['Access: team domain only', { ACCESS_TEAM_DOMAIN: 'syscd.cloudflareaccess.com', ...S }, false],
    ['Access: AUD only', { ACCESS_AUD: 'aud', ...S }, false],
    ['Access: AUD only commas', { ACCESS_TEAM_DOMAIN: 'syscd.cloudflareaccess.com', ACCESS_AUD: ' , ', ...S }, false],
    ['Access: team domain with scheme', { ...ACCESS, ACCESS_TEAM_DOMAIN: 'https://syscd.cloudflareaccess.com', ...S }, false],
    ['Google: id only', { GOOGLE_CLIENT_ID: 'cid', AUTH_ALLOWED_EMAILS: 'a@b.com', ...S }, false],
    ['Google: no allow-list', { GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'csec', ...S }, false],
    ['full Access + half Google', { ...ACCESS, GOOGLE_CLIENT_ID: 'cid', ...S }, false],
    ['full Google + half Access', { ...GOOGLE, ACCESS_AUD: 'aud', ...S }, false],
    ['Access without a strong SESSION_SECRET', { ...ACCESS, SESSION_SECRET: 'short' }, false],
  ];

  for (const [name, env, boots] of cases) {
    it(`${name}: ${boots ? 'boots' : 'refuses'} (locally and in a cluster)`, () => {
      expect(checkAuthEnv(env).length === 0).toBe(boots);
      expect(checkAuthEnv({ ...env, ...K8S }).length === 0).toBe(boots);
    });
  }

  it('Access env present turns the auth-off opt-in back into full rules', () => {
    expect(authDisabledFromEnv({ AUTH_DISABLED_OK: '1', ACCESS_AUD: 'x' })).toBe(false);
    expect(checkAuthEnv({ AUTH_DISABLED_OK: '1', ACCESS_AUD: 'x' }).length).toBeGreaterThan(0);
  });

  it('refuses the ACCESS_CERTS_URL override in a cluster and never builds it there', () => {
    const env = { ...ACCESS, ...S, ACCESS_CERTS_URL: 'http://127.0.0.1:9/certs' };
    expect(checkAuthEnv(env)).toEqual([]);
    expect(checkAuthEnv({ ...env, ...K8S })).toContain('ACCESS_CERTS_URL (dev/test JWKS override) is not allowed in a cluster');
    expect(authConfigFromEnv(env).accessCertsUrl).toBe('http://127.0.0.1:9/certs');
    expect(authConfigFromEnv({ ...env, ...K8S }).accessCertsUrl).toBe('');
  });

  it('builds the Access config: lower-cased team, AUD tags kept as written', () => {
    const cfg = authConfigFromEnv({ ACCESS_TEAM_DOMAIN: 'Syscd.CloudflareAccess.com', ACCESS_AUD: ' AbC1 ,def2,, ', ...S });
    expect(cfg.accessTeamDomain).toBe('syscd.cloudflareaccess.com');
    expect(cfg.accessAud).toEqual(['AbC1', 'def2']);
    expect(cfg.allowedEmails).toEqual([]);
  });
});

describe('AUTH_PASSWORD_LOGIN', () => {
  test('on by default, off only when explicitly off, unknown values are a boot error', () => {
    expect(passwordLoginFromEnv({})).toBe(true);
    expect(passwordLoginFromEnv({ AUTH_PASSWORD_LOGIN: '' })).toBe(true);
    expect(passwordLoginFromEnv({ AUTH_PASSWORD_LOGIN: '1' })).toBe(true);
    for (const v of ['0', 'false', 'OFF', 'no']) expect(passwordLoginFromEnv({ AUTH_PASSWORD_LOGIN: v })).toBe(false);
    expect(passwordLoginFromEnv({ AUTH_PASSWORD_LOGIN: 'maybe' })).toBeNull();
    expect(authConfigFromEnv({ ...FULL }).passwordLogin).toBe(true);
    expect(authConfigFromEnv({ ...FULL, AUTH_PASSWORD_LOGIN: '0' }).passwordLogin).toBe(false);
    expect(authConfigFromEnv({ ...FULL, AUTH_PASSWORD_LOGIN: 'maybe' }).passwordLogin).toBe(false);
    expect(checkAuthEnv({ ...FULL, AUTH_PASSWORD_LOGIN: 'maybe' }).join()).toContain('AUTH_PASSWORD_LOGIN');
    expect(checkAuthEnv({ ...FULL, AUTH_PASSWORD_LOGIN: '0' })).toEqual([]);
    expect(authConfigFromEnv({ ...FULL }).passwordHashCost).toBeUndefined();
  });
});
