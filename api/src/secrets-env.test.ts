import { describe, expect, test } from 'bun:test';

import { checkSecretsEnv, secretKeyFromEnv, SECRET_KEY_ENV } from './secrets-env';

const B64 = Buffer.alloc(32, 7).toString('base64');
const HEX = Buffer.alloc(32, 7).toString('hex');
const CLUSTER = { KUBERNETES_SERVICE_HOST: '10.0.0.1' };

describe('CREDENTIALS_ENCRYPTION_KEY', () => {
  test('in a cluster a missing (or blank) key is fatal, with the variable and how to make one in the message', () => {
    for (const env of [{ ...CLUSTER }, { ...CLUSTER, [SECRET_KEY_ENV]: '' }, { ...CLUSTER, [SECRET_KEY_ENV]: '   ' }]) {
      const errors = checkSecretsEnv(env);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain('CREDENTIALS_ENCRYPTION_KEY must be set in a cluster');
      expect(errors[0]).toContain('openssl rand -base64 32');
    }
  });

  test('locally a missing key is allowed (boot continues; own-keys operations answer an error)', () => {
    expect(checkSecretsEnv({})).toEqual([]);
    expect(checkSecretsEnv({ [SECRET_KEY_ENV]: '' })).toEqual([]);
    expect(secretKeyFromEnv({})).toBeNull();
  });

  test('a valid key boots everywhere: base64, url-safe base64 and hex give the same 32 bytes', () => {
    expect(checkSecretsEnv({ ...CLUSTER, [SECRET_KEY_ENV]: B64 })).toEqual([]);
    expect(checkSecretsEnv({ [SECRET_KEY_ENV]: HEX })).toEqual([]);
    const bytes = Buffer.alloc(32, 7);
    for (const raw of [B64, ` ${B64}\n`, HEX, HEX.toUpperCase(), Buffer.alloc(32, 0xfb).toString('base64url')]) {
      const key = secretKeyFromEnv({ [SECRET_KEY_ENV]: raw });
      expect(key).toBeInstanceOf(Uint8Array);
      expect((key as Uint8Array).length).toBe(32);
    }
    expect(Buffer.from(secretKeyFromEnv({ [SECRET_KEY_ENV]: B64 }) as Uint8Array).equals(bytes)).toBe(true);
    expect(Buffer.from(secretKeyFromEnv({ [SECRET_KEY_ENV]: HEX }) as Uint8Array).equals(bytes)).toBe(true);
  });

  test('a malformed key is fatal everywhere (a typo must not switch own keys off silently)', () => {
    for (const raw of ['short', Buffer.alloc(16, 1).toString('base64'), Buffer.alloc(48, 1).toString('base64'), 'not base64 !!', HEX.slice(2)]) {
      expect(checkSecretsEnv({ [SECRET_KEY_ENV]: raw }), raw).toHaveLength(1);
      expect(checkSecretsEnv({ ...CLUSTER, [SECRET_KEY_ENV]: raw }), raw).toHaveLength(1);
    }
  });
});
