// Dev-only stand-in for the Budget API's auth surface, used to look at the
// landing page in a browser without Postgres or Cloudflare. It answers
// /auth/me, /auth/providers, /auth/access (as if the visitor had a live
// Access session: sets the cookie, returns to return_to), /auth/logout
// (drops the cookie, redirects to APP_URL, like api/src/user/authz.ts) and
// GET /me for the profile page. Everything else is 404.
// GET /__mode?m=ok|nocookie|down&google=0|1 switches behaviour:
//   nocookie: /auth/access comes back without a session (failed round-trip)
//   down:     /auth/me answers 503 (the client's "unreachable")
const PORT = Number(process.env.STUB_PORT ?? 3196);
const APP = process.env.APP_URL ?? 'http://localhost:8091';
let mode = 'ok';
let google = false;
const COOKIE = 'budget_stub_session';
Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url);
    const cors = new Headers({
      'Access-Control-Allow-Origin': req.headers.get('origin') ?? APP,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, PATCH, PUT, DELETE, OPTIONS',
    });
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers: cors });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const signedIn = (req.headers.get('cookie') ?? '').includes(`${COOKIE}=1`);
    switch (url.pathname) {
      case '/__mode':
        mode = url.searchParams.get('m') ?? mode;
        if (url.searchParams.has('google')) google = url.searchParams.get('google') === '1';
        return new Response(`mode=${mode} google=${google}\n`);
      case '/auth/providers':
        return json({ access: true, google });
      case '/auth/me':
        if (mode === 'down') return json({ error: 'down' }, 503);
        return signedIn ? json({ email: 'stub@access.test' }) : json({ error: 'unauthorized' }, 401);
      case '/auth/access': {
        const headers = new Headers({ Location: url.searchParams.get('return_to') ?? APP });
        if (mode !== 'nocookie') headers.set('Set-Cookie', `${COOKIE}=1; Path=/; HttpOnly; SameSite=Lax`);
        return new Response(null, { status: 302, headers });
      }
      case '/auth/logout':
        return new Response(null, { status: 302, headers: { Location: APP, 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0` } });
      case '/me':
        if (!signedIn) return json({ error: 'unauthorized' }, 401);
        return json({ id: 'u1', email: 'stub@access.test', name: 'Stub Person', role: 'user', avatar: { seed: 'stub', image_version: null } });
      default:
        return json({ error: 'not found' }, 404);
    }
  },
});
console.log(`stub api on :${PORT}, app ${APP}`);
