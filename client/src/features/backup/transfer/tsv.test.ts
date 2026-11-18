/**
 * Pins the transfer archive's fixed file format: these formatters must not
 * follow the user's number/date prefs (an export must always re-import).
 */
import { describe, expect, test } from 'bun:test';

import { formatDate, formatMoney, formatMonthCell, parseDate, parseMoney, parseMonthCell } from './tsv';

describe('transfer TSV value format', () => {
  test('money: optional minus, R$, no thousands separator, comma and 2 decimals', () => {
    expect(formatMoney(-249631)).toBe('-R$2496,31');
    expect(formatMoney(374920)).toBe('R$3749,20');
    expect(formatMoney(5)).toBe('R$0,05');
    expect(parseMoney('-R$2496,31')).toBe(-249631);
    expect(parseMoney('R$ 1.314,5')).toBe(131450);
    expect(parseMoney('')).toBeNull();
  });

  test('dates: DD/MM/YYYY out, DD/MM/YYYY or ISO in', () => {
    expect(formatDate('2026-06-05')).toBe('05/06/2026');
    expect(parseDate('5/6/2026')).toBe('2026-06-05');
    expect(parseDate('2026-06-05')).toBe('2026-06-05');
    expect(parseDate('06/05/26')).toBeNull();
  });

  test('months: English 3-letter abbreviation and year', () => {
    expect(formatMonthCell(202602)).toBe('Feb 2026');
    expect(formatMonthCell(202610)).toBe('Oct 2026');
    expect(parseMonthCell('oct 2026')).toBe(202610);
    expect(parseMonthCell('Out 2026')).toBeNull();
  });
});
