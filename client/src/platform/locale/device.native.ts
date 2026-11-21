/** Device language detection, native: `expo-localization` (the OS language list). */
import { getLocales } from 'expo-localization';

/** BCP 47 tags in preference order. */
export function deviceLanguageTags(): string[] {
  return getLocales().map((l) => l.languageTag);
}

/** The pseudo-locale is a web-only dev switch (`?lang=xa`). */
export function pseudoLocaleRequested(): boolean {
  return false;
}

/** No document on native. */
export function applyDocumentLanguage(_tag: string): void {}
