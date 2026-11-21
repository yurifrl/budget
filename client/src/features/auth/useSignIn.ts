import { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';

import { authProviders } from '@shared/contracts/user/providers';
import type { KVStore } from '@/platform/storage/types';
import { clearSessionToken, saveSessionToken } from '@/platform/storage/sessionToken';
import { exchangeAccessCode, fetchSessionToken, nativeSignInUrl, parseAuthCallback, webSignInUrl } from './nativeAuth';
import {
  ACCESS_REDIRECT_KEY,
  accessNativeSignInUrl,
  accessWebSignInUrl,
  decideSignIn,
  LEGACY_PROVIDERS,
  logoutUrl,
  parseProviders,
  parseRedirectMark,
  parseSignedOutMark,
  SIGNED_OUT_KEY,
  type Providers,
  type SignInAction,
} from './signIn.logic';
import { t } from './i18n';
import type { AuthStatus } from './useAuth';

/** sessionStorage, when this is a browser that has one (null on native or when blocked). */
function session(): Storage | null {
  try {
    return Platform.OS === 'web' && typeof window !== 'undefined' ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** localStorage on web (null on native or when blocked): the sign-out mark outlives the tab. */
function local(): Storage | null {
  try {
    return Platform.OS === 'web' && typeof window !== 'undefined' ? window.localStorage : null;
  } catch {
    return null;
  }
}

const markRedirect = () => session()?.setItem(ACCESS_REDIRECT_KEY, String(Date.now()));

/**
 * Sign-in wiring for the LoginGate: asks the API which providers it has once
 * signed out, decides (signIn.logic.ts) whether to auto-redirect to
 * Cloudflare Access (web), and runs the chosen flow. Thin on purpose: the
 * decisions are the pure, tested functions.
 */
export function useSignIn(apiUrl: string, status: AuthStatus, storage: KVStore, refresh: () => void) {
  // The providers answer plus the loop-guard mark and clock read at that
  // moment (read once, in the effect: render stays pure).
  const [seen, setSeen] = useState<{ providers: Providers; lastRedirectAt: number | null; now: number; signedOut: boolean } | undefined>(
    undefined,
  );
  const providers = seen?.providers;
  const [notice, setNotice] = useState<string | null>(null);
  // Set once the window is navigating away: keep the spinner up meanwhile.
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    if (status !== 'out' || providers) return;
    let live = true;
    fetch(`${apiUrl.replace(/\/+$/, '')}${authProviders.path}`)
      .then(async (res) => parseProviders(res.status, await res.json().catch(() => null)))
      .catch(() => LEGACY_PROVIDERS)
      .then((p) => {
        if (!live) return;
        setSeen({
          providers: p,
          lastRedirectAt: parseRedirectMark(session()?.getItem(ACCESS_REDIRECT_KEY)),
          now: Date.now(),
          signedOut: parseSignedOutMark(local()?.getItem(SIGNED_OUT_KEY)),
        });
      });
    return () => {
      live = false;
    };
  }, [apiUrl, status, providers]);

  // Signed in: the automatic round-trip (if any) worked; forget it, and ask
  // again (fresh guard snapshot) if the session is ever lost later.
  useEffect(() => {
    if (status !== 'in') return;
    session()?.removeItem(ACCESS_REDIRECT_KEY);
    local()?.removeItem(SIGNED_OUT_KEY);
    setSeen(undefined);
    setRedirecting(false);
  }, [status]);

  const decided: SignInAction = decideSignIn({
    status,
    platform: Platform.OS === 'web' ? 'web' : 'native',
    providers,
    lastRedirectAt: seen?.lastRedirectAt ?? null,
    now: seen?.now ?? 0,
    signedOut: seen?.signedOut ?? false,
  });
  const action: SignInAction = redirecting && decided.kind !== 'none' ? { kind: 'pending' } : decided;

  const goAccessWeb = useCallback(() => {
    setRedirecting(true);
    markRedirect();
    window.location.href = accessWebSignInUrl(apiUrl, window.location.href);
  }, [apiUrl]);

  useEffect(() => {
    if (decided.kind === 'auto-redirect' && !redirecting) goAccessWeb();
  }, [decided.kind, redirecting, goAccessWeb]);

  const signIn = useCallback(
    async (provider: 'access' | 'google') => {
      setNotice(null);
      // Pressing a sign-in button ends "signed out on purpose".
      local()?.removeItem(SIGNED_OUT_KEY);
      if (Platform.OS === 'web') {
        // Web holds the API's httpOnly session cookie: a top-level navigation
        // through the provider ends back on this app, signed in.
        if (provider === 'access') goAccessWeb();
        else window.location.href = webSignInUrl(apiUrl);
        return;
      }
      // Native: the cookie is out of reach, so the flow runs in the system
      // auth browser and ends on our deep link with a one-time code that is
      // swapped for a session token (stored, sent as Bearer).
      const redirectUrl = Linking.createURL('/login');
      const startUrl =
        provider === 'access'
          ? accessNativeSignInUrl(apiUrl, redirectUrl)
          : `${nativeSignInUrl(apiUrl)}?redirect_uri=${encodeURIComponent(redirectUrl)}`;
      try {
        const result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUrl);
        if (result.type !== 'success' || !result.url) {
          setNotice(t('notice.cancelled'));
          return;
        }
        const parsed = parseAuthCallback(result.url);
        if (parsed.kind !== 'success') {
          // The provider's own error text is for developers; the person gets a plain sentence.
          setNotice(parsed.error === 'cancelled' ? t('notice.cancelled') : t('notice.failed'));
          return;
        }
        const outcome =
          provider === 'access'
            ? await exchangeAccessCode(apiUrl, parsed.code)
            : await fetchSessionToken(apiUrl, parsed.code, parsed.state);
        if ('error' in outcome) {
          setNotice(t('notice.failed'));
          return;
        }
        await saveSessionToken(storage, outcome.token);
        refresh();
      } catch {
        setNotice(t('notice.failed'));
      }
    },
    [apiUrl, goAccessWeb, refresh, storage],
  );

  // Explicit sign-out. Web: leave the mark (so a live Access session does not
  // sign the person straight back in), then let the API drop its cookie and
  // send the browser back here. Native: forget the token and re-probe.
  const signOut = useCallback(async () => {
    if (Platform.OS === 'web') {
      local()?.setItem(SIGNED_OUT_KEY, '1');
      window.location.href = logoutUrl(apiUrl);
      return;
    }
    await clearSessionToken(storage);
    refresh();
  }, [apiUrl, refresh, storage]);

  const error = action.kind === 'show-login' ? action.error : null;
  return { action, providers: providers ?? LEGACY_PROVIDERS, notice: notice ?? error, signIn, signOut } as const;
}
