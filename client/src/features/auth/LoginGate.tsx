import { Platform, Pressable, StyleSheet, Text, View, ActivityIndicator } from 'react-native';
import * as Linking from 'expo-linking';
import * as WebBrowser from 'expo-web-browser';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch } from '@/state/hooks';
import { resetAppState } from '@/platform/state/reset';
import { saveSessionToken } from '@/platform/storage/sessionToken';
import { colors } from '@/ui/theme';
import { fetchSessionToken, nativeSignInUrl, parseAuthCallback, webSignInUrl } from './nativeAuth';
import { useAuth } from './useAuth';

/** Gates the app behind a Google sign-in when the API requires auth (401 on
 * the session probe). An API that never answers shows a retrying connector
 * instead — with auth disabled in dev the probe succeeds once the server is
 * up, so `task run`'s server/app race resolves itself without a sign-in ask. */
export function LoginGate({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const storage = useService(Tokens.Storage);
  const { status, refresh } = useAuth(apiUrl, storage);
  const [notice, setNotice] = useState<string | null>(null);
  const dispatch = useAppDispatch();

  // The one place the signed-in identity is lost (sign-out / expired or
  // rejected session): drop every module's cached data so the next sign-in
  // (possibly another user) starts from empty caches.
  useEffect(() => {
    if (status === 'out') dispatch(resetAppState());
  }, [status, dispatch]);

  useEffect(() => {
    if (status !== 'unreachable') return;
    const timer = setInterval(() => refresh(true), 3000);
    return () => clearInterval(timer);
  }, [status, refresh]);

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.muted} />
      </View>
    );
  }

  if (status === 'unreachable') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.muted} />
        <Text style={[styles.text, styles.heading]}>Can&apos;t reach the API</Text>
        <Text style={[styles.text, styles.subtitle]}>{apiUrl}</Text>
        {__DEV__ ? (
          <Text style={[styles.text, styles.hint]}>
            Start it with `task api`. If the URL looks wrong, restart Expo with `bun start --clear`.
          </Text>
        ) : null}
        <Pressable style={styles.button} onPress={() => refresh(true)}>
          <Text style={[styles.text, styles.buttonText]}>Retry now</Text>
        </Pressable>
        <Text style={[styles.text, styles.hint]}>Retrying automatically…</Text>
      </View>
    );
  }

  if (status === 'out') {
    const signIn = async () => {
      setNotice(null);
      try {
        await runSignIn();
      } catch {
        setNotice('Sign-in failed. Please try again.');
      }
    };
    const runSignIn = async () => {
      if (Platform.OS === 'web') {
        // Web holds the API's httpOnly session cookie, so the cookie-based
        // flow (/auth/google → /auth/google/callback → back to the app) is
        // enough. The native endpoint would 400: it requires a deep-link
        // redirect_uri. See server/authz.ts.
        window.location.href = webSignInUrl(apiUrl);
        return;
      }
      // Native: the API session is an httpOnly cookie scoped to the web
      // origin, which this app's fetches can never see. Complete sign-in with
      // a system browser (ASWebAuthenticationSession / Custom Tabs) and a
      // stateless session token instead — see server/authz.ts.
      const redirectUrl = Linking.createURL('/login');
      const startUrl = `${nativeSignInUrl(apiUrl)}?redirect_uri=${encodeURIComponent(redirectUrl)}`;
      const result = await WebBrowser.openAuthSessionAsync(startUrl, redirectUrl);
      if (result.type !== 'success' || !result.url) {
        setNotice('Sign-in cancelled.');
        return;
      }
      const parsed = parseAuthCallback(result.url);
      if (parsed.kind !== 'success') {
        setNotice(parsed.error);
        return;
      }
      const outcome = await fetchSessionToken(apiUrl, parsed.code, parsed.state);
      if ('error' in outcome) {
        setNotice(outcome.error);
        return;
      }
      await saveSessionToken(storage, outcome.token);
      refresh();
    };

    return (
      <View style={styles.center}>
        <Text style={[styles.text, styles.title]}>Welcome to Budget</Text>
        <Text style={[styles.text, styles.subtitle]}>Sign in to continue</Text>
        <Pressable style={styles.button} onPress={() => void signIn()}>
          <Text style={[styles.text, styles.buttonText]}>Sign in with Google</Text>
        </Pressable>
        {notice ? <Text style={[styles.text, styles.notice]}>{notice}</Text> : null}
      </View>
    );
  }

  return <>{children}</>;
}

// Plain RN primitives on the app's dark palette (was ThemedText / the
// navigation theme in syscd): `text` mirrors ThemedText's default type,
// `heading` its `subtitle` type.
const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 24, backgroundColor: colors.bg },
  text: { color: colors.text, fontSize: 16, lineHeight: 24 },
  heading: { fontSize: 20, fontWeight: 'bold' },
  title: { fontSize: 28, fontWeight: '700' },
  subtitle: { fontSize: 15, opacity: 0.7, marginBottom: 8 },
  button: { backgroundColor: '#1a73e8', paddingVertical: 12, paddingHorizontal: 24, borderRadius: 8 },
  buttonText: { color: colors.white, fontSize: 16, fontWeight: '600' },
  hint: { fontSize: 13, opacity: 0.6, textAlign: 'center' },
  notice: { fontSize: 13, color: colors.redFg, textAlign: 'center' },
});
