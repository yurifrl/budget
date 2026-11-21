import { describe, expect, test } from 'bun:test';

import {
  checkKeysInput,
  connectGate,
  deleteErrorMessage,
  hasOwnKeys,
  isOwnKeysRequired,
  keysScreenMode,
  pausedGuidance,
  saveErrorView,
} from './pluggyKeys.logic';

const none = { clientId: null, hasSecret: false };
const saved = { clientId: 'abc-123', hasSecret: true };
const ready = (allowed: boolean) => ({ allowed, status: 'ready' as const });

describe('keysScreenMode', () => {
  test('loading until the first answer, failed when it could not be read', () => {
    expect(keysScreenMode({ credentials: undefined, isLoading: true, isError: false, replacing: false })).toBe('loading');
    expect(keysScreenMode({ credentials: undefined, isLoading: false, isError: true, replacing: false })).toBe('failed');
  });
  test('empty form when nothing is saved, even if "replacing" is left on', () => {
    expect(keysScreenMode({ credentials: none, isLoading: false, isError: false, replacing: false })).toBe('empty');
    expect(keysScreenMode({ credentials: none, isLoading: false, isError: false, replacing: true })).toBe('empty');
  });
  test('saved, or replacing when the user chose Replace', () => {
    expect(keysScreenMode({ credentials: saved, isLoading: false, isError: false, replacing: false })).toBe('saved');
    expect(keysScreenMode({ credentials: saved, isLoading: false, isError: false, replacing: true })).toBe('replacing');
  });
  test('a stale cached answer wins over a refetch error', () => {
    expect(keysScreenMode({ credentials: saved, isLoading: false, isError: true, replacing: false })).toBe('saved');
  });
});

describe('hasOwnKeys', () => {
  test('needs both a client id and a stored secret', () => {
    expect(hasOwnKeys(undefined)).toBe(false);
    expect(hasOwnKeys(none)).toBe(false);
    expect(hasOwnKeys({ clientId: 'x', hasSecret: false })).toBe(false);
    expect(hasOwnKeys(saved)).toBe(true);
  });
});

describe('checkKeysInput', () => {
  test('both fields are required (blank counts as empty)', () => {
    expect(checkKeysInput('  ', 's')?.field).toBe('clientId');
    expect(checkKeysInput('id', '')?.field).toBe('clientSecret');
    expect(checkKeysInput('id', 's')).toBeNull();
  });
});

describe('saveErrorView', () => {
  test('pluggy_keys_rejected sits under the secret field', () => {
    const view = saveErrorView({ status: 400, message: 'Pluggy did not accept', code: 'pluggy_keys_rejected' });
    expect(view.field).toBe('clientSecret');
    expect(view.message).toContain('Pluggy did not accept');
  });
  test('credentials_key_missing is a form-level message that points at the admin', () => {
    const view = saveErrorView({ status: 503, message: 'x', code: 'credentials_key_missing' });
    expect(view).toEqual({ field: 'form', message: expect.stringContaining('admin') });
  });
  test('invalid_input goes to the field the validator named', () => {
    expect(saveErrorView({ status: 400, message: 'clientId is invalid (Too big)', code: 'invalid_input' }).field).toBe('clientId');
    expect(saveErrorView({ status: 400, message: 'clientSecret is invalid (Too big)', code: 'invalid_input' }).field).toBe('clientSecret');
    expect(saveErrorView({ status: 400, message: 'request body must be valid JSON', code: 'invalid_input' })).toEqual({
      field: 'form',
      message: 'request body must be valid JSON',
    });
  });
  test('network failure and unknown errors are form-level', () => {
    expect(saveErrorView({ status: 'FETCH_ERROR', message: 'Network request failed' }).message).toContain('Could not reach');
    expect(saveErrorView({ status: 500, message: 'boom', code: 'internal' })).toEqual({ field: 'form', message: 'boom' });
    expect(saveErrorView(null)).toEqual({ field: 'form', message: 'Could not save your keys. Try again.' });
  });
});

describe('deleteErrorMessage', () => {
  test('server message, else a fallback', () => {
    expect(deleteErrorMessage({ message: 'nope' })).toBe('nope');
    expect(deleteErrorMessage(undefined)).toBe('Could not remove your keys. Try again.');
  });
});

describe('connectGate', () => {
  test('own keys always connect', () => {
    expect(connectGate({ credentials: saved, credentialsLoading: false, sharedKey: ready(false) })).toBe('connect');
    expect(connectGate({ credentials: saved, credentialsLoading: false, sharedKey: { allowed: false, status: 'loading' } })).toBe('connect');
  });
  test('the shared-key feature connects without own keys', () => {
    expect(connectGate({ credentials: none, credentialsLoading: false, sharedKey: ready(true) })).toBe('connect');
  });
  test('neither: lead to the keys screen', () => {
    expect(connectGate({ credentials: none, credentialsLoading: false, sharedKey: ready(false) })).toBe('needs_keys');
  });
  test('wait while either answer is still loading', () => {
    expect(connectGate({ credentials: none, credentialsLoading: false, sharedKey: { allowed: false, status: 'loading' } })).toBe('wait');
    expect(connectGate({ credentials: undefined, credentialsLoading: true, sharedKey: ready(false) })).toBe('wait');
  });
  test('a failed read never blocks: the API decides (403 own_keys_required)', () => {
    expect(connectGate({ credentials: undefined, credentialsLoading: false, sharedKey: ready(false) })).toBe('connect');
    expect(connectGate({ credentials: none, credentialsLoading: false, sharedKey: { allowed: false, status: 'failed' } })).toBe('connect');
  });
});

describe('isOwnKeysRequired', () => {
  test('matches the 403 code only', () => {
    expect(isOwnKeysRequired({ status: 403, message: 'x', code: 'own_keys_required' })).toBe(true);
    expect(isOwnKeysRequired({ status: 403, message: 'x', code: 'forbidden' })).toBe(false);
    expect(isOwnKeysRequired(new Error('x'))).toBe(false);
  });
});

describe('pausedGuidance', () => {
  test('null unless paused', () => {
    expect(pausedGuidance({ status: 'connected', status_message: null, key_source: 'shared' })).toBeNull();
  });
  test('shared keys: the server reason, add own keys or ask the admin', () => {
    const g = pausedGuidance({ status: 'paused', status_message: 'Paused: server says why', key_source: 'shared' });
    expect(g?.why).toBe('Paused: server says why');
    expect(g?.todo).toContain('admin');
    expect(g?.actionLabel).toBe('Add your Pluggy keys');
  });
  test('own keys: save the same key set again; generic reason without a message', () => {
    const g = pausedGuidance({ status: 'paused', status_message: null, key_source: 'own' });
    expect(g?.why).toContain('no longer saved');
    expect(g?.todo).toContain('same client id');
  });
});
