import { describe, expect, it } from 'bun:test';

import {
  ACCESS_REDIRECT_WINDOW_MS,
  ACCESS_RETRY_ERROR,
  accessNativeSignInUrl,
  accessWebSignInUrl,
  decideSignIn,
  LEGACY_PROVIDERS,
  loginButtons,
  logoutUrl,
  parseProviders,
  parseRedirectMark,
  parseSignedOutMark,
  redirectedRecently,
  type SignInState,
} from './signIn.logic';

const NOW = 1_800_000_000_000;
const ACCESS = { access: true, google: false, password: false };
const GOOGLE = { access: false, google: true, password: false };
const BOTH = { access: true, google: true, password: false };
const state = (over: Partial<SignInState> = {}): SignInState => ({
  status: 'out',
  platform: 'web',
  providers: ACCESS,
  lastRedirectAt: null,
  now: NOW,
  signedOut: false,
  ...over,
});

describe('decideSignIn', () => {
  it('does nothing unless signed out', () => {
    for (const status of ['loading', 'in', 'unreachable'] as const) {
      expect(decideSignIn(state({ status }))).toEqual({ kind: 'none' });
    }
  });

  it('waits for the providers answer', () => {
    expect(decideSignIn(state({ providers: undefined }))).toEqual({ kind: 'pending' });
  });

  it('web + Access, no recent redirect: redirects automatically', () => {
    expect(decideSignIn(state())).toEqual({ kind: 'auto-redirect' });
    expect(decideSignIn(state({ providers: BOTH }))).toEqual({ kind: 'auto-redirect' });
  });

  it('web + Access, back still signed out right after a redirect: login screen with the error (no loop)', () => {
    expect(decideSignIn(state({ lastRedirectAt: NOW - 5_000 }))).toEqual({ kind: 'show-login', error: ACCESS_RETRY_ERROR });
  });

  it('a stale redirect mark does not block a new automatic redirect', () => {
    expect(decideSignIn(state({ lastRedirectAt: NOW - ACCESS_REDIRECT_WINDOW_MS - 1 }))).toEqual({ kind: 'auto-redirect' });
  });

  it('Google only: the login screen exactly as before', () => {
    expect(decideSignIn(state({ providers: GOOGLE }))).toEqual({ kind: 'show-login', error: null });
  });

  it('native never redirects by itself', () => {
    expect(decideSignIn(state({ platform: 'native' }))).toEqual({ kind: 'show-login', error: null });
  });
});

describe('signed out on purpose', () => {
  it('web + Access: no automatic redirect, the landing page stays up without an error', () => {
    expect(decideSignIn(state({ signedOut: true }))).toEqual({ kind: 'show-login', error: null });
    expect(decideSignIn(state({ signedOut: true, providers: BOTH }))).toEqual({ kind: 'show-login', error: null });
  });

  it('outranks the loop guard: no "did not complete" error after a sign-out', () => {
    expect(decideSignIn(state({ signedOut: true, lastRedirectAt: NOW - 5_000 }))).toEqual({ kind: 'show-login', error: null });
  });

  it('changes nothing where there is no automatic redirect anyway', () => {
    expect(decideSignIn(state({ signedOut: true, providers: GOOGLE }))).toEqual({ kind: 'show-login', error: null });
    expect(decideSignIn(state({ signedOut: true, platform: 'native' }))).toEqual({ kind: 'show-login', error: null });
  });

  it('still waits for the providers answer and stays out of the way when not signed out', () => {
    expect(decideSignIn(state({ signedOut: true, providers: undefined }))).toEqual({ kind: 'pending' });
    expect(decideSignIn(state({ signedOut: true, status: 'in' }))).toEqual({ kind: 'none' });
  });

  it('once the mark is cleared (sign-in pressed), the automatic redirect is back', () => {
    expect(decideSignIn(state({ signedOut: false }))).toEqual({ kind: 'auto-redirect' });
  });

  it('parses the stored mark', () => {
    expect(parseSignedOutMark('1')).toBe(true);
    for (const none of [null, undefined, '']) expect(parseSignedOutMark(none)).toBe(false);
  });

  it('web sign-out goes through the API logout', () => {
    expect(logoutUrl('https://budget-api.syscd.live/')).toBe('https://budget-api.syscd.live/auth/logout');
  });
});

describe('redirect loop guard', () => {
  it('parses the stored mark', () => {
    expect(parseRedirectMark(String(NOW))).toBe(NOW);
    for (const bad of [null, undefined, '', 'abc', '-5', '0']) expect(parseRedirectMark(bad)).toBeNull();
  });

  it('is recent only inside the window and never for a future mark', () => {
    expect(redirectedRecently(null, NOW)).toBe(false);
    expect(redirectedRecently(NOW, NOW)).toBe(true);
    expect(redirectedRecently(NOW - ACCESS_REDIRECT_WINDOW_MS + 1, NOW)).toBe(true);
    expect(redirectedRecently(NOW - ACCESS_REDIRECT_WINDOW_MS, NOW)).toBe(false);
    expect(redirectedRecently(NOW + 60_000, NOW)).toBe(false);
  });
});

describe('parseProviders', () => {
  it('takes a valid answer', () => {
    expect(parseProviders(200, BOTH)).toEqual(BOTH);
    expect(parseProviders(200, ACCESS)).toEqual(ACCESS);
  });

  it('falls back to Google (legacy) for an old API, errors, garbage or nothing on', () => {
    expect(parseProviders(404, { error: 'not found' })).toEqual(LEGACY_PROVIDERS);
    expect(parseProviders(500, null)).toEqual(LEGACY_PROVIDERS);
    expect(parseProviders(200, { access: 'yes' })).toEqual(LEGACY_PROVIDERS);
    expect(parseProviders(200, { access: false, google: false, password: false })).toEqual(LEGACY_PROVIDERS);
  });

  it('an older API without `password` still gives its real providers', () => {
    expect(parseProviders(200, { access: true, google: false })).toEqual({ access: true, google: false, password: false });
  });

  it('keeps a password-only answer (no buttons, just the form)', () => {
    const only = { access: false, google: false, password: true };
    expect(parseProviders(200, only)).toEqual(only);
    expect(loginButtons(only)).toEqual([]);
  });
});

describe('loginButtons', () => {
  it('Access first, Google kept when both are on', () => {
    expect(loginButtons(BOTH).map((b) => b.provider)).toEqual(['access', 'google']);
    expect(loginButtons(ACCESS)).toEqual([{ provider: 'access', label: 'Sign in' }]);
    expect(loginButtons(GOOGLE)).toEqual([{ provider: 'google', label: 'Sign in with Google' }]);
  });
});

describe('Access sign-in URLs', () => {
  it('web: return_to is the encoded current URL', () => {
    expect(accessWebSignInUrl('https://budget-api.syscd.live/', 'https://budget.syscd.live/budget/x?m=1#y')).toBe(
      'https://budget-api.syscd.live/auth/access?return_to=https%3A%2F%2Fbudget.syscd.live%2Fbudget%2Fx%3Fm%3D1%23y',
    );
  });

  it('native: redirect_uri is the encoded deep link', () => {
    expect(accessNativeSignInUrl('https://budget-api.syscd.live', 'budgetapp://login')).toBe(
      'https://budget-api.syscd.live/auth/access/native?redirect_uri=budgetapp%3A%2F%2Flogin',
    );
  });
});
