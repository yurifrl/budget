import { describe, expect, test } from 'bun:test';

import { isBudgetTransfer, patchForRow, transferAccountOfPayee, transferChoices, transferTargets } from './transfers';
import type { Account } from './types';

const acct = (id: string, name: string, over: Partial<Account> = {}): Account =>
  ({ id, name, type: 'checking', group: 'CASH', onBudget: true, ...over }) as unknown as Account;

const accounts = [
  acct('chk', 'Itau Conta'),
  acct('nub', 'Nubank Conta'),
  acct('card', 'Nubank Cartão', { group: 'CREDIT' }),
  acct('house', 'House', { onBudget: false, group: 'CASH' }),
  acct('old', 'Old', { group: 'CLOSED' }),
];

const payee = (id: string, account: string | null, over: { deleted?: boolean } = {}) => ({
  id,
  name: account ? `Transfer : ${account}` : id,
  transfer_account_id: account,
  deleted: false,
  ...over,
});

describe('isBudgetTransfer: by the pointer, between two on-budget accounts', () => {
  test('both on budget', () => {
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'nub' })).toBe(true);
    expect(isBudgetTransfer(accounts, { accountId: 'nub', transferAccountId: 'card' })).toBe(true);
  });

  test('off budget on either side, an unknown account, no pointer, or its own account: not one', () => {
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'house' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'house', transferAccountId: 'chk' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'gone' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: null })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'chk' })).toBe(false);
  });
});

describe('the one account list of a transfer', () => {
  test('open accounts but the row\'s own; off-budget ones stay, closed ones go', () => {
    expect(transferTargets(accounts, 'chk').map((a) => a.id)).toEqual(['nub', 'card', 'house']);
    expect(transferTargets(accounts).map((a) => a.id)).toEqual(['chk', 'nub', 'card', 'house']);
  });

  test('"Payments and Transfers": the transfer payee of each of them, in account order', () => {
    const payees = [payee('t-nub', 'nub'), payee('t-chk', 'chk'), payee('t-house', 'house'), payee('t-old', 'old'), payee('plain', null), payee('t-card', 'card', { deleted: true })];
    expect(transferChoices(payees, accounts, 'chk').map((c) => [c.payee.id, c.account.id])).toEqual([
      ['t-nub', 'nub'],
      ['t-house', 'house'],
    ]);
  });

  test('a payee id stands for an account only when it is a transfer payee', () => {
    const payees = [payee('t-nub', 'nub'), payee('plain', null)];
    expect(transferAccountOfPayee(payees, 't-nub')).toBe('nub');
    expect(transferAccountOfPayee(payees, 'plain')).toBeNull();
    expect(transferAccountOfPayee(payees, null)).toBeNull();
  });
});

describe('patchForRow: no category on a transfer', () => {
  const transfer = { accountId: 'chk', transferAccountId: 'nub' };
  const ordinary = { accountId: 'chk', transferAccountId: null };
  const toOffBudget = { accountId: 'chk', transferAccountId: 'house' };

  test('the category is dropped from a transfer row\'s patch, the rest still applies', () => {
    expect(patchForRow<{ categoryId?: string; approved: boolean }>(accounts, transfer, { categoryId: 'c1', approved: true })).toEqual({ approved: true });
  });

  test('nothing is left to send when the patch was only a category', () => {
    expect(patchForRow(accounts, transfer, { categoryId: 'c1' })).toBeNull();
  });

  test('ordinary rows and transfers to an off-budget account take the category', () => {
    expect(patchForRow(accounts, ordinary, { categoryId: 'c1' })).toEqual({ categoryId: 'c1' });
    expect(patchForRow(accounts, toOffBudget, { categoryId: 'c1' })).toEqual({ categoryId: 'c1' });
    expect(patchForRow<{ approved: boolean }>(accounts, transfer, { approved: true })).toEqual({ approved: true });
  });
});
