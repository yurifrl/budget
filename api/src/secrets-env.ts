/**
 * Entrypoint helper for the credentials master key (the API and the worker
 * both call it). The only place CREDENTIALS_ENCRYPTION_KEY is interpreted;
 * `core/secret-box` receives the resulting key bytes.
 *
 * CREDENTIALS_ENCRYPTION_KEY: 32 random bytes, base64 (`openssl rand -base64 32`)
 * or 64 hex characters. It encrypts users' own bank-provider secrets
 * (public.connection_credentials). Losing or changing it makes the stored
 * secrets unreadable: users then save their keys again.
 *
 * Rules (same shape as auth-env.ts):
 * - In a cluster (KUBERNETES_SERVICE_HOST) the key is required: a missing or
 *   malformed value is fatal, so a failed secret injection cannot leave the
 *   pods running without it.
 * - Locally a missing key is allowed: boot continues and only the own-keys
 *   operations answer a clear error. A value that is set but malformed is
 *   fatal everywhere (a typo must not silently switch the feature off).
 * - An empty string counts as unset.
 */
import { configureSecretBox, SECRET_KEY_BYTES } from './core/secret-box';

type Env = Record<string, string | undefined>;

export const SECRET_KEY_ENV = 'CREDENTIALS_ENCRYPTION_KEY';
/** Version stamped on rows sealed with CREDENTIALS_ENCRYPTION_KEY. */
export const SECRET_KEY_VERSION = 1;

const FORMAT = `${SECRET_KEY_BYTES} random bytes as base64 (openssl rand -base64 32) or 64 hex characters`;

/** The key bytes, null when unset, or an Error describing a malformed value. */
export function secretKeyFromEnv(e: Env): Uint8Array | null | Error {
  const raw = e[SECRET_KEY_ENV]?.trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return new Uint8Array(Buffer.from(raw, 'hex'));
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(raw)) {
    const bytes = new Uint8Array(Buffer.from(raw.replaceAll('-', '+').replaceAll('_', '/'), 'base64'));
    if (bytes.length === SECRET_KEY_BYTES) return bytes;
  }
  return new Error(`${SECRET_KEY_ENV} must be ${FORMAT}`);
}

/** Fatal misconfigurations of the credentials key (empty list = may boot). */
export function checkSecretsEnv(e: Env): string[] {
  const key = secretKeyFromEnv(e);
  if (key instanceof Error) return [key.message];
  if (key === null && !!e.KUBERNETES_SERVICE_HOST?.trim()) {
    return [`${SECRET_KEY_ENV} must be set in a cluster: ${FORMAT}`];
  }
  return [];
}

/**
 * Abort boot on a fatal misconfiguration, then hand the key to core/secret-box
 * (or leave it unconfigured when the key is absent locally). Call once at startup.
 */
export function configureSecretsFromEnv(e: Env): void {
  const errors = checkSecretsEnv(e);
  if (errors.length > 0) {
    console.error('FATAL: secrets misconfiguration:\n  - ' + errors.join('\n  - '));
    process.exit(1);
  }
  const key = secretKeyFromEnv(e);
  if (key instanceof Uint8Array) {
    configureSecretBox({ current: SECRET_KEY_VERSION, keys: new Map([[SECRET_KEY_VERSION, key]]) });
  } else {
    configureSecretBox(null);
    console.warn(`${SECRET_KEY_ENV} is not set: saving and using own bank-provider keys is unavailable`);
  }
}
