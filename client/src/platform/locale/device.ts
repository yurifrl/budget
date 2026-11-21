/** Device language detection, web: the browser's preferred languages (`navigator.languages`). */

/** BCP 47 tags in preference order; empty outside a browser. */
export function deviceLanguageTags(): string[] {
  if (typeof navigator === 'undefined') return [];
  const list = navigator.languages;
  if (list && list.length > 0) return [...list];
  return navigator.language ? [navigator.language] : [];
}

/** Dev-only pseudo-locale switch: `?lang=xa` in the page URL (see docs/i18n.md). */
export function pseudoLocaleRequested(): boolean {
  if (typeof window === 'undefined' || !window.location) return false;
  return new URLSearchParams(window.location.search).get('lang') === 'xa';
}

/** Reflect the active language on the page (`<html lang>`), for screen readers and the browser. */
export function applyDocumentLanguage(tag: string): void {
  if (typeof document !== 'undefined') document.documentElement.lang = tag;
}
