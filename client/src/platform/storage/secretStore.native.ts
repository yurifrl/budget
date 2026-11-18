/** Native secret store: the iOS Keychain (Android Keystore) via expo-secure-store. */
import * as SecureStore from 'expo-secure-store';

import type { SecretStore } from './types';

export const platformSecretStore: SecretStore | null = {
  get: (key) => SecureStore.getItemAsync(key),
  set: (key, value) => SecureStore.setItemAsync(key, value),
  remove: (key) => SecureStore.deleteItemAsync(key),
};
