import { sign, verify } from 'hono/jwt';

const ALG = 'HS256' as const;

/**
 * Which sign-in minted a session. Access and password sessions are marked;
 * unmarked = Google (or older).
 */
export type SessionIdp = 'access' | 'password';

export interface SessionClaims {
  email: string;
  /** Present on sessions minted by the Cloudflare Access or the password sign-in. */
  idp?: SessionIdp;
  /**
   * Password sessions only: the `user_passwords.session_version` they were
   * minted under. A password change or an admin reset bumps the version and so
   * ends every older password session (see ./session-gate.ts).
   */
  pwv?: number;
}

/**
 * Stateless session: an HMAC-signed JWT stored in an httpOnly cookie. `idp` is
 * an additive, optional claim: sessions without it (Google, and every session
 * minted before the claim existed) verify exactly as before. A password
 * session also carries `pwv` (required for it to verify).
 */
export async function issueSession(
  secret: string,
  email: string,
  ttlSeconds: number,
  idp?: SessionIdp,
  pwv?: number,
): Promise<string> {
  if (idp === 'password' && !Number.isInteger(pwv)) throw new Error('issueSession: a password session needs its session version');
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: email.toLowerCase(),
      kind: 'session',
      ...(idp ? { idp } : {}),
      ...(idp === 'password' ? { pwv } : {}),
      iat: now,
      exp: now + ttlSeconds,
    },
    secret,
    ALG,
  );
}

export async function verifySession(secret: string, token: string): Promise<SessionClaims | null> {
  try {
    const p = await verify(token, secret, ALG);
    if (p.kind !== 'session' || typeof p.sub !== 'string') return null;
    if (p.idp === 'access') return { email: p.sub, idp: 'access' };
    if (p.idp === 'password') {
      // Never downgrade a password session to an unmarked (Google) one.
      return typeof p.pwv === 'number' && Number.isInteger(p.pwv) ? { email: p.sub, idp: 'password', pwv: p.pwv } : null;
    }
    return { email: p.sub };
  } catch {
    return null;
  }
}

/**
 * OAuth access token (server/oauth): a short-lived HS256 JWT with
 * `kind: 'access'`. The kind claim is what keeps the two token families apart
 * — verifySession accepts only `session`, verifyAccessToken only `access` —
 * so a session cookie can never act as an MCP/API bearer for a grant, and an
 * access token can never be presented as a login cookie.
 */
export interface AccessTokenClaims {
  email: string;
  scope: string;
  clientId: string;
  grantId: string;
}

export async function issueAccessToken(
  secret: string,
  claims: AccessTokenClaims & { audience: string },
  ttlSeconds: number,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    {
      sub: claims.email.toLowerCase(),
      kind: 'access',
      scope: claims.scope,
      cid: claims.clientId,
      gid: claims.grantId,
      aud: claims.audience,
      iat: now,
      exp: now + ttlSeconds,
    },
    secret,
    ALG,
  );
}

/**
 * Signature, expiry, kind and audience only — whether the grant is still
 * live is a DB question answered by activeGrant (store.ts).
 */
export async function verifyAccessToken(
  secret: string,
  token: string,
  audience: string,
): Promise<AccessTokenClaims | null> {
  try {
    const p = await verify(token, secret, ALG);
    if (p.kind !== 'access' || p.aud !== audience) return null;
    if (
      typeof p.sub !== 'string' ||
      typeof p.scope !== 'string' ||
      typeof p.cid !== 'string' ||
      typeof p.gid !== 'string'
    ) {
      return null;
    }
    return { email: p.sub, scope: p.scope, clientId: p.cid, grantId: p.gid };
  } catch {
    return null;
  }
}
