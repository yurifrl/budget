import { describe, expect, it } from 'bun:test';

import { gateView, landingLayout, LANDING_HEADLINE, UNREACHABLE_DEV_HINT, type GateState } from './landing.logic';
import { ACCESS_RETRY_ERROR } from './signIn.logic';

const gate = (over: Partial<GateState> = {}): GateState => ({
  status: 'out',
  action: { kind: 'show-login', error: null },
  providers: { access: true, google: false, password: false },
  notice: null,
  apiUrl: 'https://budget-api.example',
  dev: false,
  ...over,
});

describe('gateView', () => {
  it('signed in: the app', () => {
    expect(gateView(gate({ status: 'in', action: { kind: 'none' } }))).toEqual({ kind: 'app' });
  });

  it('never shows the landing page while a sign-in may still complete by itself', () => {
    expect(gateView(gate({ status: 'loading', action: { kind: 'none' } }))).toEqual({ kind: 'loading' });
    expect(gateView(gate({ action: { kind: 'pending' } }))).toEqual({ kind: 'loading' });
    expect(gateView(gate({ action: { kind: 'auto-redirect' } }))).toEqual({ kind: 'loading' });
  });

  it('signed out with a decision to show login: the landing page, one button per provider', () => {
    const v = gateView(gate());
    if (v.kind !== 'landing' || v.view.kind !== 'sign-in') throw new Error('expected the sign-in landing page');
    expect(v.view.headline).toBe(LANDING_HEADLINE);
    expect(v.view.buttons).toEqual([{ provider: 'access', label: 'Sign in' }]);
    expect(v.view.notice).toBeNull();

    const both = gateView(gate({ providers: { access: true, google: true, password: false } }));
    if (both.kind !== 'landing' || both.view.kind !== 'sign-in') throw new Error('expected the sign-in landing page');
    expect(both.view.buttons.map((b) => b.provider)).toEqual(['access', 'google']);
  });

  it('a failed round-trip is the same page carrying the error', () => {
    const v = gateView(gate({ action: { kind: 'show-login', error: ACCESS_RETRY_ERROR }, notice: ACCESS_RETRY_ERROR }));
    if (v.kind !== 'landing' || v.view.kind !== 'sign-in') throw new Error('expected the sign-in landing page');
    expect(v.view.notice).toBe(ACCESS_RETRY_ERROR);
    expect(v.view.buttons).toHaveLength(1);
  });

  it('unreachable API: the landing page in its unreachable state, no sign-in buttons', () => {
    const v = gateView(gate({ status: 'unreachable', action: { kind: 'none' } }));
    if (v.kind !== 'landing' || v.view.kind !== 'unreachable') throw new Error('expected the unreachable landing page');
    expect(v.view.body).toContain('https://budget-api.example');
    expect(v.view.hint).toBeNull();
  });

  it('the developer hint only shows in dev builds', () => {
    const v = gateView(gate({ status: 'unreachable', action: { kind: 'none' }, dev: true }));
    if (v.kind !== 'landing' || v.view.kind !== 'unreachable') throw new Error('expected the unreachable landing page');
    expect(v.view.hint).toBe(UNREACHABLE_DEV_HINT);
  });
});

describe('landingLayout', () => {
  it('splits only on wide windows', () => {
    expect(landingLayout({ lg: true })).toBe('split');
    expect(landingLayout({ lg: false })).toBe('stacked');
  });
});

describe('gateView password form', () => {
  it('shows the password form only when the API offers it', () => {
    const on = gateView(gate({ providers: { access: false, google: true, password: true } }));
    const off = gateView(gate({}));
    if (on.kind !== 'landing' || on.view.kind !== 'sign-in') throw new Error('expected sign-in');
    if (off.kind !== 'landing' || off.view.kind !== 'sign-in') throw new Error('expected sign-in');
    expect(on.view.passwordForm).toBe(true);
    expect(off.view.passwordForm).toBe(false);
  });
});
