/** Identity role and status — the only values the DB CHECKs admit. */
export type IdentityRole = 'admin' | 'user';
export type IdentityStatus = 'active' | 'disabled';

/**
 * A persisted identity resolved per request from public.users. Carries the
 * DB-authoritative role and status; identity fields mirror the row shape.
 */
export type IdentityUser = {
  id: string;
  email: string;
  name?: string;
  googleSub: string | null;
  role: IdentityRole;
  status: IdentityStatus;
};

/**
 * Session claims captured by authMiddleware for the requireUser seam
 * downstream. The JWT carries only `sub` = email (shape frozen per D-01),
 * so old cookies keep working with no re-login.
 */
export type SessionPrincipal = {
  email: string;
  scope?: string;
  grantId?: string;
  /** 'access' when the session (or the session behind the OAuth grant) signed in through Cloudflare Access. */
  idp?: string;
};

// Hono's documented augmentation point for middleware-captured state
// (assumption A1, hono 4.12 exports ContextVariableMap from the 'hono'
// module) — c.get('principal') / c.get('user') typecheck without casts.
declare module 'hono' {
  interface ContextVariableMap {
    principal?: SessionPrincipal;
    user?: IdentityUser;
  }
}
