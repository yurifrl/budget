/**
 * Reversible encryption for secrets the API must hand back to a provider
 * (a user's own bank-provider client secret). AES-256-GCM through WebCrypto,
 * a fresh random 96-bit nonce per value, and a caller-supplied `context`
 * bound as additional authenticated data (so a ciphertext copied onto another
 * row or user does not decrypt).
 *
 * The master key comes from the entrypoint (`configureSecretBox`; core reads
 * no env): the API and the worker both configure it from
 * CREDENTIALS_ENCRYPTION_KEY (see src/secrets-env.ts). Unconfigured, every
 * call throws `SecretBoxUnavailable`: locally that turns the own-keys
 * operations into a clear error; in a cluster boot already failed.
 *
 * Rotation: a sealed value carries `keyVersion`, the version of the master
 * key that sealed it. Today there is one key, version 1. To rotate, configure
 * the new key as the current version and keep the old one in `keys` until
 * every row is re-sealed; `open` picks the key by the stored version.
 */

export type SealedSecret = {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  keyVersion: number;
};

/** No master key (or none for the row's version): the secret cannot be sealed or opened. */
export class SecretBoxUnavailable extends Error {
  constructor(message = 'the credentials encryption key is not configured (CREDENTIALS_ENCRYPTION_KEY)') {
    super(message);
    this.name = 'SecretBoxUnavailable';
  }
}

/** The stored bytes do not open with the configured key (wrong key, wrong row, or tampered). */
export class SecretBoxOpenError extends Error {
  constructor() {
    super('the stored secret could not be decrypted with the configured key');
    this.name = 'SecretBoxOpenError';
  }
}

export const SECRET_KEY_BYTES = 32;
const NONCE_BYTES = 12;

type Keyring = { current: number; keys: Map<number, Promise<CryptoKey>> };
let keyring: Keyring | null = null;

const importKey = (raw: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey('raw', raw as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);

/**
 * Hand over the master key(s): `current` seals new values, every listed
 * version can open. `null` leaves the box unconfigured. Keys are 32 raw bytes.
 */
export function configureSecretBox(config: { current: number; keys: ReadonlyMap<number, Uint8Array> } | null): void {
  if (config === null) {
    keyring = null;
    return;
  }
  for (const [version, raw] of config.keys) {
    if (raw.length !== SECRET_KEY_BYTES) throw new Error(`secret box key v${version} must be ${SECRET_KEY_BYTES} bytes`);
  }
  if (!config.keys.has(config.current)) throw new Error(`secret box has no key for the current version v${config.current}`);
  keyring = { current: config.current, keys: new Map([...config.keys].map(([v, raw]) => [v, importKey(raw)])) };
}

export const secretBoxConfigured = (): boolean => keyring !== null;

const aad = (context: string): BufferSource => new TextEncoder().encode(context) as BufferSource;

/** Encrypt `plaintext` under the current master key. `context` must be given again to open it. */
export async function sealSecret(plaintext: string, context: string): Promise<SealedSecret> {
  if (!keyring) throw new SecretBoxUnavailable();
  const key = await keyring.keys.get(keyring.current)!;
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce as BufferSource, additionalData: aad(context) },
    key,
    new TextEncoder().encode(plaintext) as BufferSource,
  );
  return { ciphertext: new Uint8Array(ciphertext), nonce, keyVersion: keyring.current };
}

/** Decrypt a sealed value. Throws SecretBoxUnavailable (no key for its version) or SecretBoxOpenError. */
export async function openSecret(sealed: SealedSecret, context: string): Promise<string> {
  if (!keyring) throw new SecretBoxUnavailable();
  const pending = keyring.keys.get(sealed.keyVersion);
  if (!pending) throw new SecretBoxUnavailable(`no credentials encryption key for version ${sealed.keyVersion}`);
  const key = await pending;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: sealed.nonce as BufferSource, additionalData: aad(context) },
      key,
      sealed.ciphertext as BufferSource,
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new SecretBoxOpenError();
  }
}
