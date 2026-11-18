/**
 * Composition root: builds the runtime (DI container + static store) once and
 * wraps the app in its providers — gesture handler, safe area, DI services,
 * redux, navigation theme — behind the LoginGate. The budget shell (rail /
 * drawer / tabs) is the `(budget)` group's layout; profile and connected apps
 * are full-screen stack pages above it.
 */
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useColorScheme } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import 'react-native-reanimated';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { Provider as ReduxProvider } from 'react-redux';

import { LoginGate } from '@/features/auth';
import { StoreMoneyFormatProvider } from '@/shell/StoreMoneyFormatProvider';
import { ServiceProvider } from '@/platform/di/ServiceContext';
import { Tokens } from '@/platform/di/tokens';
import { createRuntime } from '@/shell/runtime';

export const unstable_settings = {
  anchor: '(budget)',
};

const runtime = createRuntime();
const apiUrl = runtime.container.resolve(Tokens.Config).apiUrl;

export default function RootLayout() {
  const colorScheme = useColorScheme();

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ServiceProvider container={runtime.container}>
          <ReduxProvider store={runtime.store}>
            <StoreMoneyFormatProvider>
            <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
              <LoginGate apiUrl={apiUrl}>
                <Stack>
                  <Stack.Screen name="(budget)" options={{ headerShown: false }} />
                  <Stack.Screen name="profile" options={{ headerShown: false }} />
                  <Stack.Screen name="connected-apps" options={{ headerShown: false }} />
                </Stack>
              </LoginGate>
              <StatusBar style="auto" />
            </ThemeProvider>
            </StoreMoneyFormatProvider>
          </ReduxProvider>
        </ServiceProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
