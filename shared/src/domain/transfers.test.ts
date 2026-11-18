import { describe, expect, test } from 'bun:test';
import { isInternalTransferPayee, transferPayeeName, transferPeerAccountId } from './transfers';

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
