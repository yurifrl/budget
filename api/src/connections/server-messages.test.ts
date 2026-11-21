import { describe, expect, test } from 'bun:test';

import { SERVER_MESSAGE_CODES } from '@shared/errors';
import { setLocale } from '@shared/i18n';
import { translateErrorCode } from '@shared/i18n/errors';

import { JOB_USER_MESSAGES } from '../jobs';
import { PAUSE_MESSAGES, PAUSED_RUN_MESSAGE, USER_MESSAGES } from './errors';
import { SERVER_MESSAGES, serverMessageCode } from './server-messages';

describe('stored server sentences -> codes', () => {
  test('every constant round-trips to its own code', () => {
    for (const [code, text] of SERVER_MESSAGES) expect(serverMessageCode(text)).toBe(code);
  });

  test('every sentence the server can store has a code, and every code has one sentence', () => {
    const stored = [
      ...Object.values(USER_MESSAGES),
      ...Object.values(PAUSE_MESSAGES),
      PAUSED_RUN_MESSAGE,
      ...Object.values(JOB_USER_MESSAGES),
    ];
    expect(stored.length).toBe(SERVER_MESSAGE_CODES.length);
    for (const text of stored) expect(serverMessageCode(text)).not.toBeNull();
    expect(SERVER_MESSAGES.map(([code]) => code).sort()).toEqual([...SERVER_MESSAGE_CODES].sort());
    expect(new Set(SERVER_MESSAGES.map(([, text]) => text)).size).toBe(SERVER_MESSAGES.length);
  });

  test('unknown text, null and near misses have no code', () => {
    expect(serverMessageCode(null)).toBeNull();
    expect(serverMessageCode(undefined)).toBeNull();
    expect(serverMessageCode('')).toBeNull();
    expect(serverMessageCode('Something else entirely')).toBeNull();
    expect(serverMessageCode(`${USER_MESSAGES.auth}.`)).toBeNull();
    expect(serverMessageCode(USER_MESSAGES.auth.toLowerCase())).toBeNull();
  });

  test('every code has a catalog message in both languages', () => {
    for (const code of SERVER_MESSAGE_CODES) {
      setLocale('en');
      const en = translateErrorCode(code);
      setLocale('pt-BR');
      const pt = translateErrorCode(code);
      setLocale('en');
      expect(en).toBeTruthy();
      expect(pt).toBeTruthy();
      expect(pt).not.toBe(en);
    }
  });
});
