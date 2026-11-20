/** The one sign-out sequence for signed-in chrome (profile page, rail menu). */
import { useRouter } from 'expo-router';
import { useCallback } from 'react';

import { useAuthSession } from './authSession';

/**
 * Sign out so that the next sign-in starts on the home page, not where the
 * person left. Web: the API's logout redirect already lands on the app root
 * (and a route change now would cancel that navigation). Native: the router
 * keeps its place, so leave first.
 */
export function useSignOutAndLeave(): () => void {
  const router = useRouter();
  const { signOut } = useAuthSession();
  return useCallback(() => {
    if (process.env.EXPO_OS !== 'web') router.dismissTo('/');
    void signOut();
  }, [router, signOut]);
}
