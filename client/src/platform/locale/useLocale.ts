import { getLocale, getLocaleKey, subscribe, type Locale } from '@shared/i18n';
import { useSyncExternalStore } from 'react';

import { useService } from '../di/ServiceContext';
import { Tokens } from '../di/tokens';
import {
  getLanguagePreference,
  setLanguagePreference,
  subscribeLanguagePreference,
  type LanguagePreference,
} from './locale';

/** The active locale; re-renders when it changes. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getLocale, getLocale);
}

/** `en`, `pt-BR` or the dev pseudo-locale `en-XA`: the key of the app's remount boundary. */
export function useLocaleKey(): string {
  return useSyncExternalStore(subscribe, getLocaleKey, getLocaleKey);
}

/** The stored language choice and a setter that persists it (device-level KV store). */
export function useLanguagePreference(): {
  preference: LanguagePreference;
  locale: Locale;
  setPreference: (pref: LanguagePreference) => Promise<void>;
} {
  const storage = useService(Tokens.Storage);
  const preference = useSyncExternalStore(subscribeLanguagePreference, getLanguagePreference, getLanguagePreference);
  const locale = useLocale();
  return { preference, locale, setPreference: (pref) => setLanguagePreference(storage, pref) };
}
