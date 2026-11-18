/**
 * Cloudflare Access assertion verifier (pure: no env, no Hono, injected fetch
 * and clock).
 *
 * A request that passed a gated Access application carries
 * `Cf-Access-Jwt-Assertion`: an RS256 JWT signed by the team's rotating keys
 * (JWKS at `https://<team>/cdn-cgi/access/certs`). We accept it only when:
 * header `alg` is exactly RS256 and a `kid` is present; the key with that kid
 * verifies the signature (WebCrypto, RSASSA-PKCS1-v1_5/SHA-256); `iss` is
 * exactly `https://<team>`; `aud` shares a tag with the configured list;
 * `exp` / `nbf` / `iat` hold within a small clock skew; and a non-empty
 * `email` is present (service-token assertions carry `common_name` and no
 * email: they never become a user).
 *
 * Keys are cached by kid for `cacheTtlMs`; an unknown kid triggers at most one
 * refetch (rate-limited by `refetchCooldownMs`, so a flood of random kids
 * cannot hammer Cloudflare). Any fetch failure fails closed.
 */

export interface AccessVerifierOptions {
  /** `<team>.cloudflareaccess.com` (no scheme). */
  teamDomain: string;
  /** Accepted AUD tags (any one must appear in the token's `aud`). */
  audiences: string[];
  /** JWKS URL override (dev/tests). Default `https://<team>/cdn-cgi/access/certs`. */
  certsUrl?: string;
  fetch?: typeof fetch;
  /** Clock in ms (tests). */
  now?: () => number;
  cacheTtlMs?: number;
  refetchCooldownMs?: number;
  timeoutMs?: number;
  clockSkewSeconds?: number;
}

export interface AccessIdentity {
  email: string;
  sub: string;
  name?: string;
}

export type AccessVerifyResult = { ok: true; identity: AccessIdentity } | { ok: false; reason: string };

export interface AccessVerifier {
  verify(token: string): Promise<AccessVerifyResult>;
}

const ALG = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null;
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  try {
    const bin = atob(pad);
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

function decodeJson(seg: string): Record<string, unknown> | null {
  const bytes = b64urlToBytes(seg);
  if (!bytes) return null;
  try {
    const v: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

interface Jwk {
  kty?: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
}

export function createAccessVerifier(opts: AccessVerifierOptions): AccessVerifier {
  const issuer = `https://${opts.teamDomain}`;
  const certsUrl = opts.certsUrl || `${issuer}/cdn-cgi/access/certs`;
  const doFetch = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const ttl = opts.cacheTtlMs ?? 10 * 60_000;
  const cooldown = opts.refetchCooldownMs ?? 10_000;
  const timeout = opts.timeoutMs ?? 5_000;
  const skew = opts.clockSkewSeconds ?? 60;
  const audiences = new Set(opts.audiences);

  let keys = new Map<string, CryptoKey>();
  let fetchedAt = -Infinity;
  let inflight: Promise<boolean> | null = null;

  async function load(): Promise<boolean> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await doFetch(certsUrl, { signal: ctrl.signal, headers: { accept: 'application/json' } });
      if (!res.ok) return false;
      const body = (await res.json()) as { keys?: Jwk[] };
      if (!Array.isArray(body?.keys)) return false;
      const next = new Map<string, CryptoKey>();
      for (const k of body.keys) {
        if (k.kty !== 'RSA' || !k.kid || !k.n || !k.e) continue;
        if (k.alg !== undefined && k.alg !== 'RS256') continue;
        if (k.use !== undefined && k.use !== 'sig') continue;
        try {
          next.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, ALG, false, ['verify']));
        } catch {
          // skip an unusable key; the others may still verify
        }
      }
      keys = next;
      fetchedAt = now();
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** One fetch at a time; concurrent callers share it. */
  function refresh(): Promise<boolean> {
    inflight ??= load().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function keyFor(kid: string): Promise<CryptoKey | null> {
    const fresh = now() - fetchedAt < ttl;
    if (!fresh) {
      // Expired (or never loaded): refetch; on failure, fail closed.
      if (!(await refresh())) return null;
      return keys.get(kid) ?? null;
    }
    const cached = keys.get(kid);
    if (cached) return cached;
    // Unknown kid on a fresh cache: maybe a rotation. One refetch, rate-limited.
    if (now() - fetchedAt < cooldown) return null;
    if (!(await refresh())) return null;
    return keys.get(kid) ?? null;
  }

  return {
    async verify(token: string): Promise<AccessVerifyResult> {
      const fail = (reason: string): AccessVerifyResult => ({ ok: false, reason });
      if (typeof token !== 'string' || token.length === 0 || token.length > 16_384) return fail('malformed');
      const parts = token.split('.');
      if (parts.length !== 3) return fail('malformed');
      const [h, p, s] = parts;
      const header = decodeJson(h);
      if (!header) return fail('malformed');
      if (header.alg !== 'RS256') return fail('alg');
      if (typeof header.kid !== 'string' || header.kid.length === 0) return fail('kid');
      const sig = b64urlToBytes(s);
      if (!sig || sig.length === 0) return fail('malformed');

      const key = await keyFor(header.kid);
      if (!key) return fail('unknown_key');
      const signed = new TextEncoder().encode(`${h}.${p}`);
      let valid = false;
      try {
        valid = await crypto.subtle.verify(ALG, key, sig, signed);
      } catch {
        valid = false;
      }
      if (!valid) return fail('signature');

      const claims = decodeJson(p);
      if (!claims) return fail('malformed');
      if (claims.iss !== issuer) return fail('iss');
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.some((a) => typeof a === 'string' && audiences.has(a))) return fail('aud');
      const t = Math.floor(now() / 1000);
      if (typeof claims.exp !== 'number' || claims.exp + skew <= t) return fail('expired');
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - skew > t)) return fail('not_yet_valid');
      if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - skew > t)) return fail('iat');
      // Service tokens: `common_name`, empty email. Never a user.
      if (claims.common_name !== undefined && claims.common_name !== '') return fail('service_token');
      const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : '';
      if (!email || !email.includes('@')) return fail('no_email');
      return {
        ok: true,
        identity: {
          email,
          sub: typeof claims.sub === 'string' ? claims.sub : '',
          name: typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim() : undefined,
        },
      };
    },
  };
}
