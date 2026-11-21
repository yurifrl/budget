import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { filterPayees } from './payees.logic';

afterEach(() => setLocale('en'));

const all = [{ name: 'Starting Balance' }, { name: 'Reconciliation Adjustment' }, { name: 'Mercado' }];

describe('filterPayees with system names', () => {
  test('pt-BR search finds a system payee by its displayed or stored name', () => {
    setLocale('pt-BR');
    expect(filterPayees(all, 'saldo').map((p) => p.name)).toEqual(['Starting Balance']);
    expect(filterPayees(all, 'balance').map((p) => p.name)).toEqual(['Starting Balance']);
    expect(filterPayees(all, 'conciliação').map((p) => p.name)).toEqual(['Reconciliation Adjustment']);
  });

  test('English search does not match the Portuguese text', () => {
    expect(filterPayees(all, 'saldo')).toEqual([]);
  });
});
