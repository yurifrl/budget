import { afterEach, describe, expect, test } from 'bun:test';

import { configureSecretBox, openSecret, sealSecret, secretBoxConfigured, SecretBoxOpenError, SecretBoxUnavailable } from './secret-box';

const key = () => crypto.getRandomValues(new Uint8Array(32));
const use = (current: number, keys: Array<[number, Uint8Array]>) => configureSecretBox({ current, keys: new Map(keys) });

afterEach(() => configureSecretBox(null));

describe('secret box (AES-256-GCM)', () => {
  test('round trip; the ciphertext is not the plaintext; 12-byte nonce; version stamped', async () => {
    use(1, [[1, key()]]);
    const sealed = await sealSecret('s3cret-väl', 'ctx');
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.nonce.length).toBe(12);
    // GCM: ciphertext = plaintext bytes + 16-byte tag.
    expect(sealed.ciphertext.length).toBe(new TextEncoder().encode('s3cret-väl').length + 16);
    expect(Buffer.from(sealed.ciphertext).includes(Buffer.from('s3cret'))).toBe(false);
    expect(await openSecret(sealed, 'ctx')).toBe('s3cret-väl');
  });

  test('a fresh random nonce per value: the same plaintext seals differently every time', async () => {
    use(1, [[1, key()]]);
    const a = await sealSecret('same', 'ctx');
    const b = await sealSecret('same', 'ctx');
    expect(Buffer.from(a.nonce).equals(Buffer.from(b.nonce))).toBe(false);
    expect(Buffer.from(a.ciphertext).equals(Buffer.from(b.ciphertext))).toBe(false);
  });

  test('does not open with another context, another key, or tampered bytes', async () => {
    use(1, [[1, key()]]);
    const sealed = await sealSecret('secret', 'user-a:pluggy');
    await expect(openSecret(sealed, 'user-b:pluggy')).rejects.toBeInstanceOf(SecretBoxOpenError);
    const flipped = { ...sealed, ciphertext: Uint8Array.from(sealed.ciphertext, (b, i) => (i === 0 ? b ^ 1 : b)) };
    await expect(openSecret(flipped, 'user-a:pluggy')).rejects.toBeInstanceOf(SecretBoxOpenError);
    use(1, [[1, key()]]);
    await expect(openSecret(sealed, 'user-a:pluggy')).rejects.toBeInstanceOf(SecretBoxOpenError);
  });

  test('unconfigured: sealing and opening throw SecretBoxUnavailable', async () => {
    use(1, [[1, key()]]);
    const sealed = await sealSecret('secret', 'ctx');
    configureSecretBox(null);
    expect(secretBoxConfigured()).toBe(false);
    await expect(sealSecret('secret', 'ctx')).rejects.toBeInstanceOf(SecretBoxUnavailable);
    await expect(openSecret(sealed, 'ctx')).rejects.toBeInstanceOf(SecretBoxUnavailable);
  });

  test('rotation: new values use the current key, old rows still open with their version', async () => {
    const k1 = key();
    const k2 = key();
    use(1, [[1, k1]]);
    const old = await sealSecret('old-secret', 'ctx');
    use(2, [[1, k1], [2, k2]]);
    expect((await sealSecret('new-secret', 'ctx')).keyVersion).toBe(2);
    expect(await openSecret(old, 'ctx')).toBe('old-secret');
    // The old key retired: its rows are unreadable, and say so.
    use(2, [[2, k2]]);
    await expect(openSecret(old, 'ctx')).rejects.toBeInstanceOf(SecretBoxUnavailable);
  });

  test('the key version is authenticated: a row relabelled to another configured version does not open', async () => {
    const k1 = key();
    use(1, [[1, k1], [2, k1]]); // even with the SAME key bytes under both versions
    const sealed = await sealSecret('secret', 'ctx');
    expect(await openSecret(sealed, 'ctx')).toBe('secret');
    await expect(openSecret({ ...sealed, keyVersion: 2 }, 'ctx')).rejects.toBeInstanceOf(SecretBoxOpenError);
  });

  test('rejects a key of the wrong size and a current version with no key', () => {
    expect(() => use(1, [[1, new Uint8Array(16)]])).toThrow(/32 bytes/);
    expect(() => use(2, [[1, key()]])).toThrow(/current version/);
  });
});
