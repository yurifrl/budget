import { describe, expect, test } from 'bun:test';

import { bankKey } from './bank-key';

describe('bankKey', () => {
  test('provider labels of one bank map to one key', () => {
    expect(bankKey('itau')).toBe('itau');
    expect(bankKey('Itaú Unibanco PF')).toBe('itau');
    expect(bankKey('Itaucard')).toBe('itau');
    expect(bankKey('Nu Pagamentos S.A.')).toBe('nubank');
    expect(bankKey('Nu Pagamentos S.A. - Instituição de Pagamento')).toBe('nubank');
    expect(bankKey('Nubank')).toBe('nubank');
    expect(bankKey('Banco do Brasil S.A.')).toBe('bb');
    expect(bankKey('Banco Inter')).toBe('inter');
  });
  test('unknown labels: accents, punctuation and company suffixes dropped', () => {
    expect(bankKey('Cooperativa Única Ltda.')).toBe('cooperativa unica');
    expect(bankKey('  ')).toBeNull();
    expect(bankKey(null)).toBeNull();
  });
});
