import { describe, expect, it } from 'bun:test';

import { authConfigFromEnv, authDisabledFromEnv, checkAuthEnv } from './auth-env';

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
    expect(errs.length).toBe(4);
    expect(errs.join('\n')).toContain('AUTH_DISABLED_OK=1');
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
