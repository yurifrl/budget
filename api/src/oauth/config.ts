/**
 * Everything the authorization server needs, passed in by the entrypoint —
 * this feature never reads process.env.
 */
export interface OAuthConfig {
  /** Public origin of this API (no trailing slash); the AS issuer. */
  issuer: string;
  /** The protected resource (MCP endpoint) URL; the `aud` of access tokens. */
  resource: string;
  /** HMAC key: signs access tokens and consent CSRF tokens. >= 32 chars. */
  secret: string;
  accessTtlSeconds: number;
  /** ABSOLUTE grant lifetime; refreshes never extend it. */
  grantTtlSeconds: number;
  codeTtlSeconds: number;
  /** Cap on dynamic client registrations per rolling hour (global). */
  registerPerHour: number;
  /**
   * Local dev with auth disabled: the email to act as when there is no
   * session cookie. null = real login required (Google hand-off).
   */
  devEmail: string | null;
}

export const SCOPES = ['read', 'write'] as const;
export const DEFAULT_SCOPE = 'read write';

export const defaultOAuthTtls = {
  accessTtlSeconds: 3600,
  grantTtlSeconds: 30 * 86400,
  codeTtlSeconds: 600,
  registerPerHour: 60,
};
