/**
 * Strings of the OAuth consent page (server-rendered HTML). The API never uses
 * the locale singleton (requests are concurrent): `requestLocale` reads the
 * `Accept-Language` header and the page renders with `t.for(locale)`.
 */
import { defineMessages, resolveLocale, type Locale } from '@shared/i18n';

import en from './en';
import ptBR from './pt-BR';

export const t = defineMessages('oauth', en, { 'pt-BR': ptBR }, { skipUnusedCheck: true });

/** Language tags of an `Accept-Language` header, highest quality first (ties keep header order). */
export function acceptLanguageTags(header: string | undefined): string[] {
  if (!header) return [];
  return header
    .split(',')
    .map((part, index) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((p) => /^\s*q\s*=\s*([\d.]+)\s*$/i.exec(p)?.[1]).find((v) => v !== undefined);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), index };
    })
    .filter((e) => e.tag !== '' && e.tag !== '*' && Number.isFinite(e.q) && e.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
    .map((e) => e.tag);
}

/** The page language for a request: Portuguese or English from `Accept-Language`, else English. */
export function requestLocale(acceptLanguage: string | undefined): Locale {
  return resolveLocale(acceptLanguageTags(acceptLanguage));
}
