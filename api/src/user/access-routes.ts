/**
 * Sign in with Cloudflare Access (pre-gate, hand-written like the Google
 * routes). Live only when Access is configured (team domain + AUD tags);
 * otherwise every route here answers 404, as if not mounted.
 *
 *   GET  /auth/access?return_to=<api path | web-app URL>
 *        Cloudflare gates this path with the Access policy (the only list of
 *        who may sign in this way: AUTH_ALLOWED_EMAILS is Google's) and adds
 *        `Cf-Access-Jwt-Assertion`. We verify it (./access.ts), resolve or
 *        create the user exactly like the Google callback, set the
 *        `budget_session` cookie and redirect to the validated return_to.
 *   GET  /auth/access/native?redirect_uri=<budgetapp://... | exp://...>
 *        Same verification, then a short-lived one-time exchange code is
 *        handed to the app on its deep link (never the session token).
 *   POST /auth/exchange  { code } -> { token, email }
 *        The app swaps the code for a session token (Bearer). Deliberately
 *        OUTSIDE the /auth/access prefix: the Access application gates
 *        `/auth/access*`, and this is a plain fetch from the app, which could
 *        not answer a Cloudflare login.
 *
 * The assertion is read from the header ONLY: never the `CF_Authorization`
 * cookie, never the query. If the path is not actually behind Access (say,
 * the app was misconfigured as bypass) no header arrives and the answer is
 * 401: nothing else is ever trusted.
 */
import type { Context, Hono } from 'hono';
import { sign, verify } from 'hono/jwt';

import { errorResponse } from '../core/validate';
import { createAccessVerifier, type AccessIdentity, type AccessVerifier } from './access';
import { accessConfigured, authConfig, type AuthConfig } from './config';
import { safeLoginRedirect } from './return-to';
import { mintSessionToken, setSessionCookie } from './session-cookie';
import { EmailAlreadyProvisionedError, resolveOrCreateSessionUser } from './store';

export const ACCESS_ASSERTION_HEADER = 'Cf-Access-Jwt-Assertion';
const EXCHANGE_TTL_SECONDS = 120;
const EXCHANGE_KIND = 'access_exchange';

let cached: { cfg: AuthConfig; verifier: AccessVerifier } | null = null;

/** The verifier for the installed config (rebuilt when configureAuth runs again). */
function verifier(): AccessVerifier {
  const cfg = authConfig();
  if (cached?.cfg !== cfg) {
    cached = {
      cfg,
      verifier: createAccessVerifier({
        teamDomain: cfg.accessTeamDomain,
        audiences: cfg.accessAud,
        certsUrl: cfg.accessCertsUrl || undefined,
        fetch: cfg.accessFetch,
      }),
    };
  }
  return cached.verifier;
}

type Verified = { ok: true; identity: AccessIdentity } | { ok: false; status: 401 | 403; message: string; code: string };

/**
 * Header-only assertion -> provisioned identity. No API-side allow-list: the
 * Cloudflare Access policy decided who reaches this route, and the verified
 * assertion is the proof. Someone the app has never seen gets a user row here
 * (role 'user', no budgets); an invited e-mail links to its pre-provisioned
 * row, so the budgets shared with it are there on first sign-in.
 */
async function signInFromAssertion(c: Context): Promise<Verified> {
  const token = c.req.header(ACCESS_ASSERTION_HEADER);
  if (!token) {
    return { ok: false, status: 401, message: 'no Cloudflare Access assertion on this request', code: 'access_assertion_missing' };
  }
  const result = await verifier().verify(token);
  if (!result.ok) {
    console.warn(`auth/access: assertion rejected (${result.reason})`);
    return { ok: false, status: 401, message: 'invalid Cloudflare Access assertion', code: 'access_assertion_invalid' };
  }
  const { identity } = result;
  try {
    // Same capture as the Google callback: links a pre-provisioned/invited
    // row by e-mail, fills a missing name only. No sub: the Access `sub` is
    // not a Google subject and must never land in google_sub.
    await resolveOrCreateSessionUser(identity.email, { name: identity.name });
  } catch (err) {
    if (err instanceof EmailAlreadyProvisionedError) {
      return { ok: false, status: 403, message: 'email already provisioned', code: 'email_already_provisioned' };
    }
    throw err;
  }
  return { ok: true, identity };
}

// One-time use of exchange codes, per process. Codes live 2 minutes; with
// several API replicas a code could be redeemed once per replica inside that
// window (accepted: it still only ever yields the same person's session).
const redeemed = new Map<string, number>();
function markRedeemed(jti: string, exp: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  for (const [k, e] of redeemed) if (e < now) redeemed.delete(k);
  if (redeemed.has(jti)) return false;
  redeemed.set(jti, exp);
  return true;
}

async function mintExchangeCode(email: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return sign(
    { kind: EXCHANGE_KIND, sub: email, jti: crypto.randomUUID(), iat: now, exp: now + EXCHANGE_TTL_SECONDS },
    authConfig().sessionSecret,
    'HS256',
  );
}

async function redeemExchangeCode(code: string): Promise<string | null> {
  try {
    const p = await verify(code, authConfig().sessionSecret, 'HS256');
    if (p.kind !== EXCHANGE_KIND || typeof p.sub !== 'string' || typeof p.jti !== 'string' || typeof p.exp !== 'number') return null;
    return markRedeemed(p.jti, p.exp) ? p.sub : null;
  } catch {
    return null;
  }
}

const notMounted = (c: Context) => errorResponse(c, 404, 'not found');

export function mountAccessRoutes(app: Hono): void {
  app.get('/auth/access', async (c) => {
    if (!accessConfigured()) return notMounted(c);
    c.header('Cache-Control', 'no-store');
    const signedIn = await signInFromAssertion(c);
    if (!signedIn.ok) return errorResponse(c, signedIn.status, signedIn.message, signedIn.code);
    await setSessionCookie(c, signedIn.identity.email, 'access');
    const cfg = authConfig();
    return c.redirect(safeLoginRedirect(c.req.query('return_to'), cfg.apiBaseUrl, cfg.appOrigin) ?? cfg.appOrigin);
  });

  app.get('/auth/access/native', async (c) => {
    if (!accessConfigured()) return notMounted(c);
    c.header('Cache-Control', 'no-store');
    const appUri = c.req.query('redirect_uri') ?? c.req.query('redirect') ?? '';
    const schemes = authConfig().nativeRedirectSchemes;
    if (!schemes.some((p) => appUri.toLowerCase().startsWith(p.toLowerCase()))) {
      return errorResponse(c, 400, `redirect_uri must be an ${schemes.join(' or ')} URL`, 'invalid_redirect_uri');
    }
    const signedIn = await signInFromAssertion(c);
    // The app's URL is validated: report failures there so the in-app
    // browser closes with a message instead of stranding on a JSON page.
    if (!signedIn.ok) return c.redirect(`${appUri}?${new URLSearchParams({ error: signedIn.code })}`);
    const code = await mintExchangeCode(signedIn.identity.email);
    return c.redirect(`${appUri}?${new URLSearchParams({ code, state: 'access' })}`);
  });

  app.post('/auth/exchange', async (c) => {
    if (!accessConfigured()) return notMounted(c);
    c.header('Cache-Control', 'no-store');
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const email = typeof body?.code === 'string' ? await redeemExchangeCode(body.code) : null;
    if (!email) return errorResponse(c, 400, 'sign-in expired, try again', 'invalid_code');
    // The code was minted by /auth/access/native after a verified assertion.
    return c.json({ token: await mintSessionToken(email, 'access'), email });
  });
}
