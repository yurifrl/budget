/** Plural categories. Only the two forms both locales need; no ICU. */

import type { Locale } from './types';

export type PluralCategory = 'one' | 'other';

/** en: exactly 1 is singular. pt-BR: 0 and 1 are singular ("0 transação", "1 transação"). */
export function pluralCategory(locale: Locale, n: number): PluralCategory {
  if (locale === 'pt-BR') return n === 0 || n === 1 ? 'one' : 'other';
  return n === 1 ? 'one' : 'other';
}
