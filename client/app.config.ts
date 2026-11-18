import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: 'Budget',
  slug: 'budget',
  scheme: 'budgetapp',
  owner: 'yurifrl',
  version: '0.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'live.syscd.budget',
    infoPlist: { ITSAppUsesNonExemptEncryption: false },
  },
  // Kept configured; not built in this phase.
  android: {
    package: 'live.syscd.budget',
    predictiveBackGestureEnabled: false,
  },
  web: { output: 'single' },
  plugins: ['expo-router'],
  experiments: {
    typedRoutes: true,
    reactCompiler: true,
  },
  extra: {
    router: {},
    // eas.projectId: set once the owner creates the EAS project.
  },
});
