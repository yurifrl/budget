import { describe, expect, test } from 'bun:test';
import { isInternalTransferPayee, isTransferToOnBudget, transferPayeeName, transferPeerAccountId } from './transfers';

const accounts = [
  { name: 'QA Cash', onBudget: true },
  { name: 'Itau Conta Corrente', onBudget: true },
  { name: 'House', onBudget: false },
];

describe('transfer payees', () => {
  test('transferPayeeName builds the canonical payee', () => {
    expect(transferPayeeName('QA Cash')).toBe('Transfer : QA Cash');
  });

  test('on-budget peer is an internal transfer (no category needed)', () => {
    expect(isInternalTransferPayee('Transfer : Itau Conta Corrente', accounts)).toBe(true);
    expect(isInternalTransferPayee('Transfer : ITAU conta corrente', accounts)).toBe(true);
  });

  test('off-budget peer, unknown peer and plain payees are not', () => {
    expect(isInternalTransferPayee('Transfer : House', accounts)).toBe(false);
    expect(isInternalTransferPayee('Transfer : Nowhere', accounts)).toBe(false);
    expect(isInternalTransferPayee('Padaria', accounts)).toBe(false);
  });
});

describe('transferPeerAccountId (legacy payee -> account id, spec T1)', () => {
  const accts = [
    { id: 'a1', name: 'Itau Conta Corrente' },
    { id: 'a2', name: 'Itau Cartão' },
    { id: 'a3', name: 'Twin' },
    { id: 'a4', name: 'twin' },
  ];
  test('resolves the named account, case-insensitive, any budget side', () => {
    expect(transferPeerAccountId('Transfer : Itau Cartão', accts, 'a1')).toBe('a2');
    expect(transferPeerAccountId('Transfer :   itau conta corrente ', accts, 'a2')).toBe('a1');
  });
  test('plain payees, unknown names, ambiguous names and the own account resolve to nothing', () => {
    expect(transferPeerAccountId('Padaria', accts, 'a1')).toBeUndefined();
    expect(transferPeerAccountId('Transfer : Nowhere', accts, 'a1')).toBeUndefined();
    expect(transferPeerAccountId('Transfer : Twin', accts, 'a1')).toBeUndefined();
    expect(transferPeerAccountId('Transfer : Itau Cartão', accts, 'a2')).toBeUndefined();
  });
});

describe('isTransferToOnBudget', () => {
  const accounts = [
    { id: 'chk', onBudget: true },
    { id: 'sav', onBudget: true },
    { id: 'house', onBudget: false },
  ];

  test('a pointer to another on-budget account: the money stays in the budget', () => {
    expect(isTransferToOnBudget(accounts, 'chk', 'sav')).toBe(true);
    // The register has always looked at the peer only: a leg on an off-budget account pointing at an on-budget one counts.
    expect(isTransferToOnBudget(accounts, 'house', 'chk')).toBe(true);
  });

  test('an off-budget peer, an unknown account, no pointer or its own account: no', () => {
    expect(isTransferToOnBudget(accounts, 'chk', 'house')).toBe(false);
    expect(isTransferToOnBudget(accounts, 'chk', 'gone')).toBe(false);
    expect(isTransferToOnBudget(accounts, 'chk', null)).toBe(false);
    expect(isTransferToOnBudget(accounts, 'chk', undefined)).toBe(false);
    expect(isTransferToOnBudget(accounts, 'chk', 'chk')).toBe(false);
  });
});
