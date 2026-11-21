/**
 * Composition root: builds the runtime (DI container + static store) once and
 * wraps the app in its providers — gesture handler, safe area, DI services,
 * redux, navigation theme — behind the LoginGate. `index` is the home page
 * (my budgets / shared with me), where a signed-in person starts and picks a
 * budget; the budget shell (rail / drawer / tabs) is the `(budget)` group's
 * layout; profile and connected apps are full-screen stack pages.
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider as ReduxProvider } from 'react-redux';

import { LoginGate } from '@/features/auth';
import { StoreMoneyFormatProvider } from '@/shell/StoreMoneyFormatProvider';
import { ServiceProvider } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { initDeviceLocale, initLocale } from '@/platform/locale/locale';
import { useLocaleKey } from '@/platform/locale/useLocale';
import { createRuntime } from '@/shell/runtime';

export const unstable_settings = {
  anchor: 'index',
};

const runtime = createRuntime();
const apiUrl = runtime.container.resolve(Tokens.Config).apiUrl;

// The device language, synchronously, before the first render; the stored
// override (Settings > Display > Language) is applied in RootLayout before
// children render. See platform/locale/locale.ts.
initDeviceLocale();

/**
 * Remounts its subtree when the language changes. Not optional: the React
 * Compiler (`experiments.reactCompiler`) may memoize `t()` results per
 * component, so a new locale would otherwise leave stale text on screen.
 */
function LocaleBoundary({ children }: { children: ReactNode }) {
  return <Fragment key={useLocaleKey()}>{children}</Fragment>;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  const [localeReady, setLocaleReady] = useState(false);
  useEffect(() => {
    void initLocale(runtime.container.resolve(Tokens.Storage)).finally(() => setLocaleReady(true));
  }, []);
  if (!localeReady) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ServiceProvider container={runtime.container}>
          <ReduxProvider store={runtime.store}>
            <StoreMoneyFormatProvider>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <LocaleBoundary>
              <LoginGate apiUrl={apiUrl}>
                <Stack>
                  <Stack.Screen name="index" options={{ headerShown: false }} />
                  {/* No edge-swipe back: the budget's screens are tabs, so a
                      swipe anywhere would drop the person out of the budget. */}
                  <Stack.Screen name="(budget)" options={{ headerShown: false, gestureEnabled: false }} />
                  <Stack.Screen name="profile" options={{ headerShown: false }} />
                  <Stack.Screen name="connected-apps" options={{ headerShown: false }} />
                </Stack>
              </LoginGate>
              </LocaleBoundary>
              <StatusBar style="auto" />
            </ThemeProvider>
            </StoreMoneyFormatProvider>
          </ReduxProvider>
        </ServiceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
