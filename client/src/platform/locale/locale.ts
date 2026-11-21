/**
 * The device-wide language: the one deliberate module singleton of the client
 * (docs/architecture.md). Boot order, see `app/_layout.tsx`:
 *
 *   1. `initDeviceLocale()` (sync, module load): the device's language.
 *   2. `initLocale(storage)` (async, before children render): the stored
 *      `app.language` override, if any.
 *
 * The preference lives in the device-level KV store, not in the per-budget
 * settings blob: the landing and home pages render before a budget is active.
 */
import {
  LOCALES,
  resolveLocale,
  setLocale,
  setPseudoLocale,
  subscribe as subscribeLocale,
  getLocale,
  type Locale,
} from '@shared/i18n';

import type { KVStore } from '../storage/types';
import { applyDocumentLanguage, deviceLanguageTags, pseudoLocaleRequested, reloadApp } from './device';

/** KVStore key of the language preference (same family as `budget.activeBudgetId`). */
export const LANGUAGE_STORAGE_KEY = 'app.language';

/** `system` follows the device; otherwise a fixed locale. */
export type LanguagePreference = 'system' | Locale;

export const LANGUAGE_PREFERENCES = ['system', ...LOCALES] as const satisfies readonly LanguagePreference[];

let preference: LanguagePreference = 'system';
const listeners = new Set<() => void>();

/** Unknown stored values fall back to `system`. */
export function parseLanguagePreference(value: unknown): LanguagePreference {
  return (LANGUAGE_PREFERENCES as readonly unknown[]).includes(value) ? (value as LanguagePreference) : 'system';
}

/** The locale a preference gives on a device with these language tags. */
export function localeForPreference(pref: LanguagePreference, deviceTags: readonly string[]): Locale {
  return pref === 'system' ? resolveLocale(deviceTags) : pref;
}

function apply(pref: LanguagePreference): void {
  setLocale(localeForPreference(pref, deviceLanguageTags()));
  applyDocumentLanguage(getLocale());
  if (pref !== preference) {
    preference = pref;
    for (const listener of [...listeners]) listener();
  }
}

/** Step 1, synchronous: set the device's language (and the web `?lang=xa` pseudo-locale) before anything renders. */
export function initDeviceLocale(): void {
  setLocale(resolveLocale(deviceLanguageTags()));
  setPseudoLocale(pseudoLocaleRequested());
  applyDocumentLanguage(getLocale());
}

/** Step 2: read the stored override and apply it. Resolves to the preference now in effect. */
export async function initLocale(storage: KVStore): Promise<LanguagePreference> {
  const stored = parseLanguagePreference(await storage.get<unknown>(LANGUAGE_STORAGE_KEY, 'system'));
  apply(stored);
  return stored;
}

/**
 * Persist and apply a language choice. Web reloads the page (a remount would
 * reset expo-router to the home page); native applies it live and the locale
 * boundary in `app/_layout.tsx` remounts the app.
 */
export async function setLanguagePreference(storage: KVStore, pref: LanguagePreference): Promise<void> {
  if (pref === 'system') await storage.remove(LANGUAGE_STORAGE_KEY);
  else await storage.set(LANGUAGE_STORAGE_KEY, pref);
  if (localeForPreference(pref, deviceLanguageTags()) !== getLocale() && reloadApp()) return;
  apply(pref);
}

export function getLanguagePreference(): LanguagePreference {
  return preference;
}

/** Notified when the preference changes (the locale itself: `subscribe` of `@shared/i18n`). */
export function subscribeLanguagePreference(listener: () => void): () => void {
  listeners.add(listener);
  const off = subscribeLocale(listener);
  return () => {
    listeners.delete(listener);
    off();
  };
}
