/**
 * Which sign-in the LoginGate offers, and when the web app may send the
 * browser to Cloudflare Access by itself. Pure (no React, no RN): the gate's
 * hook (useSignIn.ts) only wires these to fetch, sessionStorage and
 * window.location.
 *
 * Web + Access: a signed-out visit navigates ONCE, top-level, to
 * `<api>/auth/access?return_to=<this URL>`. Someone with a live Access
 * session comes straight back signed in; anyone else gets Cloudflare's login.
 * A timestamp in sessionStorage marks that navigation: coming back still
 * signed out inside the window means the round-trip failed (cookie blocked,
 * API refused), so the gate shows the login screen with an error instead of
 * redirecting again (no loops).
 *
 * Signed out on purpose: "Sign out" leaves a mark in localStorage before the
 * session is dropped. While it is there the web app never redirects by
 * itself (a live Access session would sign the person straight back in);
 * the landing page stays up until they press a sign-in button, which clears
 * the mark, as does any successful sign-in.
 */
import { authProvidersSchema } from '@shared/contracts/user/providers';
import type { z } from '@shared/zod';

export type Providers = z.infer<typeof authProvidersSchema>;

/** What an API that predates /auth/providers (or can't be asked) offers: Google, as before. */
export const LEGACY_PROVIDERS: Providers = { access: false, google: true };

/** sessionStorage key holding the time (ms) of the last automatic Access redirect. */
export const ACCESS_REDIRECT_KEY = 'budget.accessAutoRedirectAt';
/** A return inside this window, still signed out, counts as a failed round-trip. */
export const ACCESS_REDIRECT_WINDOW_MS = 2 * 60_000;

/** localStorage key set by an explicit sign-out (web); present = no automatic redirect. */
export const SIGNED_OUT_KEY = 'budget.signedOutOnPurpose';

export const ACCESS_RETRY_ERROR = 'Automatic sign-in with Cloudflare Access did not complete. Try again.';

const base = (apiUrl: string) => apiUrl.replace(/\/+$/, '');

/** Web: the Access sign-in, returning to `returnTo` (a URL on this app's origin). */
export function accessWebSignInUrl(apiUrl: string, returnTo: string): string {
  return `${base(apiUrl)}/auth/access?return_to=${encodeURIComponent(returnTo)}`;
}

/** Native: the Access sign-in in the in-app browser, ending on the app's deep link. */
export function accessNativeSignInUrl(apiUrl: string, redirectUri: string): string {
  return `${base(apiUrl)}/auth/access/native?redirect_uri=${encodeURIComponent(redirectUri)}`;
}

/** Web sign-out: the API drops its session cookie and redirects back to the app. */
export function logoutUrl(apiUrl: string): string {
  return `${base(apiUrl)}/auth/logout`;
}

/** Stored sign-out mark -> whether the person signed out on purpose. */
export function parseSignedOutMark(raw: string | null | undefined): boolean {
  return Boolean(raw);
}

/** The providers answer, or LEGACY_PROVIDERS for anything unusable (404, bad JSON, none on). */
export function parseProviders(status: number, body: unknown): Providers {
  if (status !== 200) return LEGACY_PROVIDERS;
  const parsed = authProvidersSchema.safeParse(body);
  if (!parsed.success || (!parsed.data.access && !parsed.data.google)) return LEGACY_PROVIDERS;
  return parsed.data;
}

/** Stored guard value -> timestamp, or null when absent/garbled. */
export function parseRedirectMark(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** True when an automatic redirect happened recently (so another one would loop). */
export function redirectedRecently(markAt: number | null, now: number, windowMs = ACCESS_REDIRECT_WINDOW_MS): boolean {
  return markAt !== null && now >= markAt && now - markAt < windowMs;
}

export type SignInAction =
  /** Signed in, loading or unreachable: the gate has nothing sign-in related to do. */
  | { kind: 'none' }
  /** Signed out, still asking the API which providers exist: keep the spinner. */
  | { kind: 'pending' }
  /** Navigate the window to the Access sign-in now. */
  | { kind: 'auto-redirect' }
  /** Show the login screen (with an error after a failed automatic round-trip). */
  | { kind: 'show-login'; error: string | null };

export interface SignInState {
  status: 'loading' | 'in' | 'out' | 'unreachable';
  platform: 'web' | 'native';
  /** undefined while the providers request is in flight. */
  providers: Providers | undefined;
  /** ACCESS_REDIRECT_KEY's value (web), null when none. */
  lastRedirectAt: number | null;
  now: number;
  /** SIGNED_OUT_KEY is set (web): the person chose "Sign out" and has not pressed sign-in since. */
  signedOut: boolean;
}

export function decideSignIn(s: SignInState): SignInAction {
  if (s.status !== 'out') return { kind: 'none' };
  if (!s.providers) return { kind: 'pending' };
  if (s.platform !== 'web' || !s.providers.access) return { kind: 'show-login', error: null };
  // An explicit sign-out outranks everything automatic, the loop-guard error included.
  if (s.signedOut) return { kind: 'show-login', error: null };
  if (redirectedRecently(s.lastRedirectAt, s.now)) return { kind: 'show-login', error: ACCESS_RETRY_ERROR };
  return { kind: 'auto-redirect' };
}

export interface LoginButton {
  provider: 'access' | 'google';
  label: string;
}

/** Buttons on the login screen: Access first (the default), Google when it is on too. */
export function loginButtons(p: Providers): LoginButton[] {
  const out: LoginButton[] = [];
  if (p.access) out.push({ provider: 'access', label: 'Sign in' });
  if (p.google) out.push({ provider: 'google', label: 'Sign in with Google' });
  return out;
}
