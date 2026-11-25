import { describe, expect, test } from 'bun:test';

import { draftTransferAccount, isBudgetTransfer, isEngineTransfer, legacyTransferAccountByName, patchForRow, transferAccountOfPayee, transferChoices, transferTargets } from './transfers';
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

describe('isBudgetTransfer: by the pointer, to an on-budget account', () => {
  test('both on budget', () => {
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'nub' })).toBe(true);
    expect(isBudgetTransfer(accounts, { accountId: 'nub', transferAccountId: 'card' })).toBe(true);
  });

  test('the peer is what counts (as the register always did): a leg on an off-budget account pointing at an on-budget one needs no category', () => {
    expect(isBudgetTransfer(accounts, { accountId: 'house', transferAccountId: 'chk' })).toBe(true);
  });

  test('an off-budget peer, an unknown account, no pointer, or its own account: not one', () => {
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'house' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'gone' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: null })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'chk', transferAccountId: 'chk' })).toBe(false);
  });
});

describe('isEngineTransfer: what the engine skips (both accounts on budget)', () => {
  test('on-budget to on-budget only; a leg in an off-budget account is not one even though the register reads its cell as not needed', () => {
    expect(isEngineTransfer(accounts, { accountId: 'chk', transferAccountId: 'nub' })).toBe(true);
    expect(isEngineTransfer(accounts, { accountId: 'house', transferAccountId: 'chk' })).toBe(false);
    expect(isBudgetTransfer(accounts, { accountId: 'house', transferAccountId: 'chk' })).toBe(true);
    expect(isEngineTransfer(accounts, { accountId: 'chk', transferAccountId: 'house' })).toBe(false);
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

describe('legacyTransferAccountByName (legacy fallback until the server repair links the old payees)', () => {
  const named = (name: string, id = name.toLowerCase()) => ({ id, name });
  const budget = [named('Itau Conta', 'chk'), named('Nubank Cartão', 'card'), named('Old', 'old')];

  test('exactly one account of that name: a transfer to it', () => {
    expect(legacyTransferAccountByName('Transfer : Nubank Cartão', budget, 'chk')).toBe('card');
    expect(legacyTransferAccountByName('Transfer:nubank cartão', budget, 'chk')).toBe('card'); // as the client always read it
  });

  test('a closed account counts (the repair has not linked it either)', () => {
    expect(legacyTransferAccountByName('Transfer : Old', budget, 'chk')).toBe('old');
  });

  test('two accounts with that name: ambiguous, not a transfer', () => {
    expect(legacyTransferAccountByName('Transfer : Itau Conta', [...budget, named('Itau Conta', 'chk2')], 'card')).toBeNull();
  });

  test('an account renamed since: the old payee text names nothing, not a transfer', () => {
    const renamed = [named('Itau Conta', 'chk'), named('Cartão Roxo', 'card')];
    expect(legacyTransferAccountByName('Transfer : Nubank Cartão', renamed, 'chk')).toBeNull();
  });

  test('the row\'s own account, an ordinary name or an empty one: not a transfer', () => {
    expect(legacyTransferAccountByName('Transfer : Itau Conta', budget, 'chk')).toBeNull();
    expect(legacyTransferAccountByName('Padaria', budget, 'chk')).toBeNull();
    expect(legacyTransferAccountByName('', budget, 'chk')).toBeNull();
  });
});

describe('draftTransferAccount: what locks the category of a row being edited', () => {
  const payees = [{ id: 'tp-nub', transfer_account_id: 'nub' }, { id: 'p1', transfer_account_id: null }];

  test('an untouched legacy row (no payee id, text only) keeps its transfer pointer: locked', () => {
    const legacy = { payee: 'Transfer : Nubank', payeeId: null, transferAccountId: 'nub' };
    expect(draftTransferAccount(legacy, { payee: 'Transfer : Nubank', payeeId: null }, payees)).toBe('nub');
  });

  test('an untouched row with a payee id keeps its pointer', () => {
    const row = { payee: 'Transfer : Nubank', payeeId: 'tp-nub', transferAccountId: 'nub' };
    expect(draftTransferAccount(row, { payee: 'Transfer : Nubank', payeeId: 'tp-nub' }, payees)).toBe('nub');
  });

  test('a payee changed to an ordinary one, or typed over, unlocks it', () => {
    const row = { payee: 'Transfer : Nubank', payeeId: 'tp-nub', transferAccountId: 'nub' };
    expect(draftTransferAccount(row, { payee: 'Padaria', payeeId: 'p1' }, payees)).toBeNull();
    expect(draftTransferAccount(row, { payee: 'Transfer : Nuban', payeeId: null }, payees)).toBeNull();
  });

  test('a new row, or a changed payee, is a transfer when the picked payee is an account\'s transfer payee', () => {
    expect(draftTransferAccount(null, { payee: 'Transfer : Nubank', payeeId: 'tp-nub' }, payees)).toBe('nub');
    expect(draftTransferAccount(null, { payee: 'Padaria', payeeId: 'p1' }, payees)).toBeNull();
    expect(draftTransferAccount(null, { payee: '', payeeId: null }, payees)).toBeNull();
  });
});
