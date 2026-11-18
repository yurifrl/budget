import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** SHA-256 hex: the only form in which codes and refresh tokens are stored. */
export const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/** 256-bit random opaque secret, base64url. */
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** Constant-time string equality (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const VERIFIER_RE = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE_RE = /^[A-Za-z0-9_-]{43,128}$/;

/** PKCE S256: base64url(sha256(verifier)) === challenge, constant time. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER_RE.test(verifier)) return false;
  const computed = createHash('sha256').update(verifier).digest('base64url');
  return safeEqual(computed, challenge);
}

export const hmacBase64Url = (secret: string, data: string): string =>
  createHmac('sha256', secret).update(data).digest('base64url');
