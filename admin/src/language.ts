/**
 * The language preference of the admin: `system` (the browser's languages) or a
 * fixed locale, stored in `localStorage` under `app.language` and applied at
 * boot, before the first render. A change reloads the page (docs/i18n.md).
 */
import { LOCALES, getLocale, resolveLocale, setLocale, setPseudoLocale, type Locale } from '@shared/i18n';

export const LANGUAGE_STORAGE_KEY = 'app.language';

export type LanguagePreference = 'system' | Locale;

export const LANGUAGE_PREFERENCES = ['system', ...LOCALES] as const satisfies readonly LanguagePreference[];

/** Unknown stored values fall back to `system`. */
export function parseLanguagePreference(value: unknown): LanguagePreference {
  return (LANGUAGE_PREFERENCES as readonly unknown[]).includes(value) ? (value as LanguagePreference) : 'system';
}

/** The locale a preference gives for these browser language tags. */
export function localeForPreference(pref: LanguagePreference, tags: readonly string[]): Locale {
  return pref === 'system' ? resolveLocale(tags) : pref;
}

export function readLanguagePreference(): LanguagePreference {
  try {
    return parseLanguagePreference(window.localStorage.getItem(LANGUAGE_STORAGE_KEY));
  } catch {
    return 'system';
  }
}

const browserTags = (): readonly string[] =>
  navigator.languages && navigator.languages.length > 0 ? navigator.languages : navigator.language ? [navigator.language] : [];

/** Boot: apply the stored preference (else the browser's language) and `?lang=xa`, before the first render. */
export function initLocale(): void {
  setLocale(localeForPreference(readLanguagePreference(), browserTags()));
  setPseudoLocale(new URLSearchParams(window.location.search).get('lang') === 'xa');
  document.documentElement.lang = getLocale();
}

/** Store the choice and reload so the whole page starts in the new language. */
export function saveLanguagePreference(pref: LanguagePreference): void {
  try {
    if (pref === 'system') window.localStorage.removeItem(LANGUAGE_STORAGE_KEY);
    else window.localStorage.setItem(LANGUAGE_STORAGE_KEY, pref);
  } catch {
    // storage unavailable: the choice cannot persist
  }
  window.location.reload();
}
