/**
 * Test kit for Cloudflare Access assertions: a local RSA key pair, a JWKS
 * served by a fake fetch (call counting, failure switch), and a signer for
 * RS256 / HS256 / `none` tokens. Used by the verifier unit tests, the
 * Access route tests and the e2e sign-in test. Never used by production code.
 */
import { createHmac } from 'node:crypto';

export const TEAM = 'test-team.cloudflareaccess.com';
export const ISS = `https://${TEAM}`;
export const AUD = 'aud-web-tag';

const enc = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export interface TestKey {
  kid: string;
  privateKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
}

export async function makeKey(kid: string): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid } };
}

/** A valid Access app-token claim set for `email` (override any claim). */
export function claims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], email: 'person@example.com', exp: now + 600, iat: now - 5, nbf: now - 5, iss: ISS, sub: 'cf-sub-1', type: 'app', ...over };
}

export async function signRs256(key: TestKey, payload: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const h = enc({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const p = enc(payload);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}

/** Algorithm confusion: HS256 keyed with the PUBLIC key's JSON. */
export function signHs256WithPublicKey(key: TestKey, payload: Record<string, unknown>): string {
  const h = enc({ alg: 'HS256', kid: key.kid, typ: 'JWT' });
  const p = enc(payload);
  const sig = createHmac('sha256', JSON.stringify(key.jwk)).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

export function unsigned(kid: string, payload: Record<string, unknown>): string {
  return `${enc({ alg: 'none', kid, typ: 'JWT' })}.${enc(payload)}.`;
}

/** A fake JWKS endpoint: `keys` is mutable (rotation), `fail` simulates an outage. */
export function fakeJwks(initial: TestKey[]) {
  const state = { keys: initial, fail: false, calls: 0, urls: [] as string[] };
  const fetchImpl = (async (input: RequestInfo | URL) => {
    state.calls++;
    state.urls.push(String(input));
    if (state.fail) throw new Error('network down');
    return new Response(JSON.stringify({ keys: state.keys.map((k) => k.jwk) }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  return { state, fetch: fetchImpl };
}
