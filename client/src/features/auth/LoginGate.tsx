import { ActivityIndicator, StyleSheet, View } from 'react-native';
import type { ReactNode } from 'react';
import { useEffect, useMemo } from 'react';

import { useService } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { useAppDispatch } from '@/state/hooks';
import { resetAppState } from '@/platform/state/reset';
import { colors } from '@/ui/theme';
import { AuthSessionContext } from './authSession';
import { gateView } from './landing.logic';
import { LandingPage } from './LandingPage';
import { useAuth } from './useAuth';
import { useSignIn } from './useSignIn';

/** Gates the app behind a sign-in when the API requires auth (401 on the
 * session probe): Cloudflare Access (on web, automatically, once, unless the
 * person signed out on purpose) and/or Google, whichever the API reports at
 * /auth/providers. Signed out, or with an API that never answers, the
 * LandingPage is shown (the unreachable state retries by itself: with auth
 * disabled in dev the probe succeeds once the server is up, so `task run`'s
 * server/app race resolves without a sign-in ask). What to show is decided
 * in landing.logic.ts. */
export function LoginGate({ apiUrl, children }: { apiUrl: string; children: ReactNode }) {
  const storage = useService(Tokens.Storage);
  const { status, refresh } = useAuth(apiUrl, storage);
  const { action, providers, notice, signIn, signOut } = useSignIn(apiUrl, status, storage, refresh);
  const dispatch = useAppDispatch();
  const session = useMemo(() => ({ signOut }), [signOut]);

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

  const view = gateView({ status, action, providers, notice, apiUrl, dev: __DEV__ });

  if (view.kind === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.muted} />
      </View>
    );
  }
  if (view.kind === 'landing') {
    return <LandingPage view={view.view} onSignIn={signIn} onRetry={() => refresh(true)} />;
  }
  return <AuthSessionContext.Provider value={session}>{children}</AuthSessionContext.Provider>;
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
});
