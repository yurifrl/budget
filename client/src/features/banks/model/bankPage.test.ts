import { describe, expect, test } from 'bun:test';

import { milliToCents } from '@/budget/data/mapping';
import { bankDisplayName, txnStateView } from './bankPage';

describe('bankDisplayName', () => {
  test('title-cases raw lowercase ids, keeps real names', () => {
    expect(bankDisplayName('nubank', 'pluggy')).toBe('Nubank');
    expect(bankDisplayName('banco-inter', 'pluggy')).toBe('Banco Inter');
    expect(bankDisplayName('Itaú Unibanco', 'pluggy')).toBe('Itaú Unibanco');
    expect(bankDisplayName('itau', 'pluggy')).toBe('Itaú');
    expect(bankDisplayName(null, 'pluggy')).toBe('Pluggy');
    expect(bankDisplayName('  ', 'pluggy')).toBe('Pluggy');
  });
});

describe('milliToCents / txnStateView', () => {
  test('converts milliunits to cents', () => {
    expect(milliToCents(-12340)).toBe(-1234);
    expect(milliToCents(0)).toBe(0);
  });
  test('states map to labels', () => {
    expect(txnStateView('imported').label).toBe('Imported');
    expect(txnStateView('edited').tone).toBe('warn');
    expect(txnStateView('removed').label).toBe('Removed at bank');
  });
});
