import { describe, expect, test } from 'bun:test';

import type { JevKeyStatus } from '@shared/contracts/jev';

import {
  jevKeyCardMode,
  keyFieldProblem,
  loadErrorMessage,
  removeErrorMessage,
  saveErrorMessage,
  savedOn,
  serverKeyInUse,
  testErrorMessage,
  unreadableNotice,
} from './jevKey.logic';

const status = (extra: Partial<JevKeyStatus> = {}): JevKeyStatus => ({
  last_four: null,
  saved_at: null,
  using_server_key: false,
  reason: 'flag_off',
  ...extra,
});

const saved = status({ last_four: '1234', saved_at: '2026-11-26T12:00:00.000Z', reason: null });

describe('jevKeyCardMode', () => {
  test('loading until the first answer, failed when it could not be read', () => {
    expect(jevKeyCardMode({ status: undefined, isLoading: true, isError: false, replacing: false })).toBe('loading');
    expect(jevKeyCardMode({ status: undefined, isLoading: false, isError: true, replacing: false })).toBe('failed');
  });

  test('the field when no key is saved, whatever "replacing" says', () => {
    expect(jevKeyCardMode({ status: status(), isLoading: false, isError: false, replacing: false })).toBe('form');
    expect(jevKeyCardMode({ status: status(), isLoading: false, isError: false, replacing: true })).toBe('form');
  });

  test('saved, or the field again after Replace', () => {
    expect(jevKeyCardMode({ status: saved, isLoading: false, isError: false, replacing: false })).toBe('saved');
    expect(jevKeyCardMode({ status: saved, isLoading: false, isError: false, replacing: true })).toBe('form');
  });

  test('a stale cached answer wins over a refetch error', () => {
    expect(jevKeyCardMode({ status: saved, isLoading: false, isError: true, replacing: false })).toBe('saved');
  });
});

describe('keyFieldProblem', () => {
  test('only an empty field blocks the save; the server judges the key itself', () => {
    expect(keyFieldProblem('')).not.toBeNull();
    expect(keyFieldProblem('   ')).not.toBeNull();
    expect(keyFieldProblem('sk-or-v1-0123456789abcdef')).toBeNull();
  });
});

describe('savedOn', () => {
  test('the date part the formatter takes, null while nothing is saved', () => {
    expect(savedOn(saved)).toBe('2026-11-26');
    expect(savedOn(status())).toBeNull();
  });
});

describe('serverKeyInUse', () => {
  test('only when no own key is saved and the server key is available', () => {
    expect(serverKeyInUse(status({ using_server_key: true }))).toBe(true);
    expect(serverKeyInUse(status({ using_server_key: false }))).toBe(false);
    expect(serverKeyInUse(saved)).toBe(false);
    expect(serverKeyInUse(undefined)).toBe(false);
  });
});

describe('error messages', () => {
  test('a refused key is named on save and on test', () => {
    expect(saveErrorMessage({ status: 400, code: 'jev_key_rejected' })).toBe(
      'Jev refused this key. Check it in OpenRouter and save it again.',
    );
    expect(testErrorMessage({ status: 400, code: 'jev_key_rejected' }, saved)).toBe(
      'Jev refused this key. Check it in OpenRouter and save it again.',
    );
  });

  test('an installation with no encryption key says so', () => {
    expect(saveErrorMessage({ status: 503, code: 'credentials_key_missing' })).toBe(
      'This server cannot store keys right now. Ask the person who runs it.',
    );
  });

  test('testing with nothing saved asks for a key first', () => {
    expect(testErrorMessage({ status: 400, code: 'jev_key_missing' }, status())).toBe('Save a Jev key first.');
  });

  test('a saved key this server cannot open is not reported as "no key saved"', () => {
    const unreadable = status({ reason: 'key_unreadable' });
    expect(testErrorMessage({ status: 400, code: 'jev_key_missing' }, unreadable)).toBe(
      'Your saved key cannot be read on this server. Save it again.',
    );
    expect(unreadableNotice(unreadable)).toBe('Your saved key cannot be read on this server. Save it again.');
    expect(unreadableNotice(saved)).toBeNull();
  });

  test('a key with no credits left says so on save and on test', () => {
    const message = 'The OpenRouter account behind this key has no credits left. Add credits or use another key.';
    expect(saveErrorMessage({ status: 402, code: 'jev_no_credits' })).toBe(message);
    expect(testErrorMessage({ status: 402, code: 'jev_no_credits' }, saved)).toBe(message);
  });

  test('a failed remove is our failure, never the key\'s', () => {
    expect(removeErrorMessage({ status: 500, message: 'boom' })).toBe('Could not remove the key.');
    expect(removeErrorMessage({ status: 401, code: 'unauthorized' })).toBe('Could not remove the key.');
  });

  test('anything else falls back to our sentence, and an offline save says so', () => {
    expect(saveErrorMessage({ status: 500, message: 'boom' })).toBe('Could not save the key.');
    expect(saveErrorMessage({ status: 'FETCH_ERROR' })).toBe(
      'Could not reach the server. Check your connection and try again.',
    );
    expect(loadErrorMessage({ status: 500, message: 'boom' })).toBe('Could not read your Jev key.');
  });
});
