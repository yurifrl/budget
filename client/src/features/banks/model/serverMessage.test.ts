import { afterEach, describe, expect, test } from 'bun:test';

import { setLocale } from '@shared/i18n';

import { translateErrorCode } from '@shared/i18n/errors';

import { pausedGuidance } from '../keys/pluggyKeys.logic';
import { storedServerMessage } from './serverMessage';
import { describeSyncOutcome } from './syncRun';

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

describe('stored sentences at the sites that show them', () => {
  const run = {
    id: 'r1',
    status: 'failed' as const,
    mode: 'sync' as const,
    created_at: '2026-01-01T00:00:00Z',
    finished_at: null,
    user_message: 'Couldn\'t reach the bank. We will try again later.',
    user_message_code: 'server_transient',
    result: null,
  };

  test('a sync run error reads in the active language', () => {
    setLocale('pt-BR');
    const out = describeSyncOutcome({ kind: 'done', run }, 'Sync');
    expect(out.kind).toBe('error');
    expect(out.text).not.toBe(run.user_message);
    expect(out.text).toBe(translateErrorCode('server_transient'));
  });

  test('a paused connection explains itself in the active language', () => {
    setLocale('pt-BR');
    const g = pausedGuidance({
      status: 'paused',
      status_message: 'Paused: the Pluggy keys this bank was connected with are no longer saved. Save that key set again to resume.',
      status_message_code: 'server_paused_own_keys',
      key_source: 'own',
    });
    expect(g?.why).toBe(translateErrorCode('server_paused_own_keys'));
  });
});
