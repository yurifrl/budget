/**
 * Password primitives: argon2id hashing (Bun.password), the constant-work
 * dummy verification, server-generated temporary passwords and the
 * single-purpose change token. No SQL, no HTTP.
 *
 * Nothing here logs; callers must never log a password, a temporary password
 * or a hash either.
 */
import { randomBytes } from 'node:crypto';
import { sign, verify } from 'hono/jwt';

import { authConfig } from './config';

/** argon2id with the configured cost (production: Bun's defaults, 64 MiB, t=2). */
export function hashPassword(password: string): Promise<string> {
  const cost = authConfig().passwordHashCost;
  return Bun.password.hash(password, cost ? { algorithm: 'argon2id', ...cost } : { algorithm: 'argon2id' });
}

/** Verify against a stored PHC string; a malformed hash is a plain mismatch. */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

let dummy: { key: string; hash: Promise<string> } | null = null;

function dummyHash(): Promise<string> {
  const key = JSON.stringify(authConfig().passwordHashCost ?? null);
  if (dummy?.key !== key) dummy = { key, hash: hashPassword(randomBytes(32).toString('base64url')) };
  return dummy.hash;
}

/** Make the dummy hash ahead of the first request, so the first unknown e-mail is not slower. */
export function warmDummyHash(): void {
  void dummyHash().catch(() => undefined);
}

/**
 * Burn one verification when there is nothing real to check (unknown e-mail,
 * no password row), so every failed login costs about the same time. Always
 * false. The dummy hash uses the current cost and is made once per cost.
 */
export async function verifyDummy(password: string): Promise<false> {
  await verifyPassword(password, await dummyHash());
  return false;
}

/** No 0/o, 1/l/i: easy to read out loud and type. 31 symbols, ~4.95 bits each. */
const TEMP_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const TEMP_GROUPS = 4;
const TEMP_GROUP_LEN = 5;
/** Temporary passwords expire after this many days. */
export const TEMP_PASSWORD_TTL_DAYS = 7;

/**
 * A server-generated temporary password: 20 symbols from a 31-letter
 * alphabet (~99 bits), in four dash-separated groups of five
 * (`abcde-fghjk-mnpqr-stuvw`). Unbiased (rejection sampling).
 */
export function generateTempPassword(): string {
  const out: string[] = [];
  const limit = 256 - (256 % TEMP_ALPHABET.length);
  while (out.length < TEMP_GROUPS * TEMP_GROUP_LEN) {
    for (const b of randomBytes(32)) {
      if (b >= limit) continue;
      out.push(TEMP_ALPHABET[b % TEMP_ALPHABET.length]!);
      if (out.length === TEMP_GROUPS * TEMP_GROUP_LEN) break;
    }
  }
  const groups: string[] = [];
  for (let i = 0; i < TEMP_GROUPS; i++) groups.push(out.slice(i * TEMP_GROUP_LEN, (i + 1) * TEMP_GROUP_LEN).join(''));
  return groups.join('-');
}

export const TEMP_PASSWORD_ALPHABET = TEMP_ALPHABET;

const CHANGE_KIND = 'password_change';
/** Lifetime of a change token (seconds). */
export const CHANGE_TOKEN_TTL_SECONDS = 600;

export interface ChangeTokenClaims {
  email: string;
  userId: string;
  /** session_version of the password row when the token was minted. */
  pwv: number;
}

/**
 * The single-purpose token a correct temporary password earns: kind
 * `password_change`, so verifySession (kind `session`), verifyAccessToken
 * (kind `access`) and the Access exchange (kind `access_exchange`) all refuse
 * it. Single use: completing bumps session_version, and completion requires
 * the version the token carries.
 */
export async function mintChangeToken(claims: ChangeTokenClaims): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { kind: CHANGE_KIND, sub: claims.email, uid: claims.userId, pwv: claims.pwv, iat: now, exp: now + CHANGE_TOKEN_TTL_SECONDS },
    authConfig().sessionSecret,
    'HS256',
  );
}

export async function verifyChangeToken(token: string): Promise<ChangeTokenClaims | null> {
  try {
    const p = await verify(token, authConfig().sessionSecret, 'HS256');
    if (p.kind !== CHANGE_KIND || typeof p.sub !== 'string' || typeof p.uid !== 'string' || typeof p.pwv !== 'number') return null;
    return { email: p.sub, userId: p.uid, pwv: p.pwv };
  } catch {
    return null;
  }
}
