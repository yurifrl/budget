import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { displaySystemName, matchesSystemName } from './systemNames';

afterEach(() => setLocale('en'));

describe('displaySystemName', () => {
  test('English shows the stored names as they are', () => {
    expect(displaySystemName('Starting Balance')).toBe('Starting Balance');
    expect(displaySystemName('Reconciliation Adjustment')).toBe('Reconciliation Adjustment');
    expect(displaySystemName('Credit Card Payments')).toBe('Credit Card Payments');
    expect(displaySystemName('Transfer : Nubank')).toBe('Transfer : Nubank');
  });

  test('pt-BR translates the three fixed names and the transfer prefix', () => {
    setLocale('pt-BR');
    expect(displaySystemName('Starting Balance')).toBe('Saldo inicial');
    expect(displaySystemName('Reconciliation Adjustment')).toBe('Ajuste de conciliação');
    expect(displaySystemName('Credit Card Payments')).toBe('Pagamentos de cartão de crédito');
    expect(displaySystemName('Transfer : Conta Corrente')).toBe('Transferência : Conta Corrente');
  });

  test('the account name after the transfer prefix is untouched, even when it looks like a system name', () => {
    setLocale('pt-BR');
    expect(displaySystemName('Transfer : Starting Balance')).toBe('Transferência : Starting Balance');
    expect(displaySystemName('Transfer : ')).toBe('Transferência : ');
  });

  test('a user name that merely contains the words, or differs in case, is returned as is', () => {
    setLocale('pt-BR');
    for (const name of [
      'My Starting Balance',
      'starting balance',
      'Starting Balance 2',
      'Reconciliation Adjustment (old)',
      'Credit Card Payments Inc',
      'Transfer: Nubank',
      'Transfer to savings',
      'Mercado',
      '',
    ]) {
      expect(displaySystemName(name)).toBe(name);
    }
  });
});

describe('matchesSystemName', () => {
  test('plain names match by substring, as before', () => {
    expect(matchesSystemName('Mercado Livre', 'livre')).toBe(true);
    expect(matchesSystemName('Mercado Livre', 'xyz')).toBe(false);
    expect(matchesSystemName('Mercado Livre', '')).toBe(true);
  });

  test('a system name matches its stored and its displayed text in pt-BR', () => {
    setLocale('pt-BR');
    expect(matchesSystemName('Starting Balance', 'saldo')).toBe(true);
    expect(matchesSystemName('Starting Balance', 'balance')).toBe(true);
    expect(matchesSystemName('Reconciliation Adjustment', 'concilia')).toBe(true);
    expect(matchesSystemName('Transfer : Nubank', 'transferência')).toBe(true);
    expect(matchesSystemName('Transfer : Nubank', 'nubank')).toBe(true);
    expect(matchesSystemName('Starting Balance', 'mercado')).toBe(false);
  });

  test('in English only the stored text matches', () => {
    expect(matchesSystemName('Starting Balance', 'saldo')).toBe(false);
    expect(matchesSystemName('Starting Balance', 'start')).toBe(true);
  });
});
