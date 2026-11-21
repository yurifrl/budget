import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { storedServerMessage } from './serverMessage';

afterEach(() => setLocale('en'));

describe('storedServerMessage', () => {
  test('uses the stored text without a code', () => {
    expect(storedServerMessage('Reconnect your bank.', null)).toBe('Reconnect your bank.');
    expect(storedServerMessage('Reconnect your bank.', undefined)).toBe('Reconnect your bank.');
  });

  test('translates a known code, in either language', () => {
    expect(storedServerMessage('stored', 'server_reconnect_bank')).toBe('Reconnect your bank.');
    setLocale('pt-BR');
    expect(storedServerMessage('Reconnect your bank.', 'server_reconnect_bank')).not.toBe('Reconnect your bank.');
  });

  test('falls back to the text for an unknown code, and null when there is nothing', () => {
    expect(storedServerMessage('Some text', 'server_unheard_of')).toBe('Some text');
    expect(storedServerMessage(null, null)).toBeNull();
    expect(storedServerMessage(undefined, 'nope')).toBeNull();
  });
});
