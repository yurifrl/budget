/**
 * Google Sign-In (OpenID Connect), passwordless. We never store a password —
 * Google proves identity and hands us a verified email + name. Authorization
 * (who's allowed) is decided separately in the members store.
 *
 * The id_token comes straight from Google's token endpoint over TLS, so we
 * trust its payload without re-verifying the signature via JWKS.
 */
import { authConfig } from "./config";

const AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

export const googleConfigured = (): boolean =>
  !!(authConfig().googleClientId && authConfig().googleClientSecret);

export function googleAuthUrl(redirectUri: string, state: string): string {
  const p = new URLSearchParams({
    client_id: authConfig().googleClientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid email profile",
    state,
    access_type: "online",
    prompt: "select_account",
  });
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

export type GoogleIdentity = { email: string; name?: string; sub: string; emailVerified: boolean };

function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  const seg = idToken.split(".")[1];
  if (!seg) return null;
  try {
    const json = Buffer.from(seg.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function exchangeCode(code: string, redirectUri: string): Promise<GoogleIdentity | null> {
  const body = new URLSearchParams({
    code,
    client_id: authConfig().googleClientId,
    client_secret: authConfig().googleClientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) return null;
  const json = (await res.json()) as { id_token?: string };
  if (!json.id_token) return null;
  const p = decodeJwtPayload(json.id_token);
  const email = typeof p?.email === "string" ? p.email.toLowerCase() : null;
  if (!email || typeof p?.sub !== "string") return null;
  // Defense-in-depth: even though the id_token came straight from Google's TLS
  // token endpoint, validate the core OIDC claims so this never silently
  // accepts a token minted for another client or an expired one.
  const now = Math.floor(Date.now() / 1000);
  if (p.aud !== authConfig().googleClientId) return null;
  if (p.iss !== "accounts.google.com" && p.iss !== "https://accounts.google.com") return null;
  if (typeof p.exp !== "number" || p.exp < now) return null;
  return {
    email,
    name: typeof p.name === "string" ? p.name : undefined,
    sub: p.sub,
    emailVerified: p.email_verified === true,
  };
}
