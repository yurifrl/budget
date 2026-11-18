/**
 * Statement-import money coercion — pure helpers.
 *
 * Follows the app's pt-BR convention and reuses `parseMoneyWith('pt-BR')`
 * ("1.314,51", "R$ 50,00", "1234.56"); bank CSVs frequently also wrap
 * negatives in parentheses ("(50.00)"), which is handled here before
 * delegating.
 */

import { parseMoneyWith } from '@/domain/format';
import type { Cents } from '@/domain/types';

// ---------------------------------------------------------------------------
// Money: signs and parentheses, then the shared pt-BR parser
// ---------------------------------------------------------------------------
/** Parse a CSV amount cell; null when it is not a number. */
export function parseImportAmount(input: string): Cents | null {
  let s = input.trim().replace(/^"|"$/g, '');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith('-') || s.startsWith('−')) {
    negative = true;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  // Statement files are pt-BR by convention, independent of the UI preference.
  const cents = parseMoneyWith('pt-BR', s);
  if (s.trim() !== '' && cents === 0 && !/^[0,\.\s]*$/.test(s.replace(/^R\$|^US\$/i, '').trim())) {
    return null;
  }
  return negative ? -cents : cents;
}
