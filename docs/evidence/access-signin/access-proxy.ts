// Dev-only stand-in for the Cloudflare edge: serves a JWKS for a local key at
// /certs, injects a signed Cf-Access-Jwt-Assertion on /auth/access*, forwards
// everything to the local API, and strips the cookie Domain (localhost).
// GET /__mode?m=ok|nocookie|noheader switches behaviour.
const API = process.env.UPSTREAM ?? 'http://localhost:3196';
const PORT = Number(process.env.PROXY_PORT ?? 3197);
const TEAM = 'test-team.cloudflareaccess.com';
const AUD = 'aud-local';
const EMAIL = process.env.ACCESS_EMAIL ?? 'browser@access.test';
let mode = 'ok';
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
const jwk = { kty: 'RSA', n: pub.n, e: pub.e, alg: 'RS256', use: 'sig', kid: 'local-kid' };
const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
async function assertion() {
  const now = Math.floor(Date.now() / 1000);
  const h = enc({ alg: 'RS256', kid: jwk.kid, typ: 'JWT' });
  const p = enc({ aud: [AUD], email: EMAIL, exp: now + 600, iat: now, nbf: now, iss: `https://${TEAM}`, sub: 'local-sub', type: 'app' });
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${Buffer.from(sig).toString('base64url')}`;
}
Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/certs') return Response.json({ keys: [jwk] });
    if (url.pathname === '/__mode') { mode = url.searchParams.get('m') ?? 'ok'; return new Response(`mode=${mode}\n`); }
    const headers = new Headers(req.headers);
    headers.delete('cf-access-jwt-assertion'); // the edge never forwards a client-supplied one
    if (url.pathname.startsWith('/auth/access') && mode !== 'noheader') headers.set('Cf-Access-Jwt-Assertion', await assertion());
    const res = await fetch(`${API}${url.pathname}${url.search}`, { method: req.method, headers, body: req.body, redirect: 'manual' });
    const out = new Headers(res.headers);
    out.delete('set-cookie');
    if (!(url.pathname.startsWith('/auth/access') && mode === 'nocookie')) {
      for (const c of res.headers.getSetCookie()) out.append('set-cookie', c.replace(/;\s*Domain=[^;]*/i, ''));
    }
    return new Response(res.body, { status: res.status, headers: out });
  },
});
console.log(`access proxy on :${PORT} -> ${API}`);
