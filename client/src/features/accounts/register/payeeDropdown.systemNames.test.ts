import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import type { PayeeAdminRow } from '@/budget/data/rows';
import type { Account } from '@/domain/types';
import { payeeMenu, payeeSections } from './payeeDropdown.logic';

afterEach(() => setLocale('en'));

const accounts = [{ id: 'a1', name: 'Nubank', group: 'CASH', onBudget: true }] as unknown as Account[];
const payees = [
  { id: 'tp1', name: 'Transfer : Nubank', transfer_account_id: 'a1', hidden: false, deleted: false },
  { id: 'p1', name: 'Starting Balance', transfer_account_id: null, hidden: false, deleted: false },
  { id: 'p2', name: 'Mercado', transfer_account_id: null, hidden: false, deleted: false },
] as unknown as PayeeAdminRow[];
const sections = (value: string) => payeeSections({ accounts, currentAccountId: null, payees, value });
const items = (value: string) => sections(value).flatMap((s) => s.items);

describe('payee picker with system names (pt-BR)', () => {
  test('rows show the translated name but commit the stored English one', () => {
    setLocale('pt-BR');
    const all = items('');
    expect(all.find((i) => i.key === 'payee:p1')).toMatchObject({ label: 'Saldo inicial', commit: 'Starting Balance' });
    expect(all.find((i) => i.key === 'transfer:a1')).toMatchObject({ label: 'Transferência : Nubank', commit: 'Transfer : Nubank' });
  });

  test('the typed text finds the displayed name and the stored name', () => {
    setLocale('pt-BR');
    expect(items('saldo').map((i) => i.commit)).toEqual(['Starting Balance']);
    expect(items('balance').map((i) => i.commit)).toEqual(['Starting Balance']);
    expect(items('transferência').map((i) => i.commit)).toEqual(['Transfer : Nubank']);
    expect(items('mercado').map((i) => i.commit)).toEqual(['Mercado']);
  });

  test('the selected row shows the translated name, the field keeps the stored one', () => {
    setLocale('pt-BR');
    const selected = sections('Starting Balance')[0];
    expect(selected.items[0]).toMatchObject({ kind: 'selected', label: 'Saldo inicial', commit: 'Starting Balance', checked: true });
  });

  test('typing the stored name exactly does not offer to create a payee', () => {
    setLocale('pt-BR');
    expect(payeeMenu(sections('Starting Balance'), 'Starting Balance').showCreate).toBe(false);
    expect(payeeMenu(sections('Saldo inicial'), 'Saldo inicial').showCreate).toBe(false);
  });
});
