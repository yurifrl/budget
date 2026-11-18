import { beforeAll, describe, expect, it } from 'bun:test';

import { createAccessVerifier, type AccessVerifierOptions } from './access';
import { AUD, claims, fakeJwks, makeKey, signHs256WithPublicKey, signRs256, TEAM, unsigned, type TestKey } from './access-test-kit';

let k1: TestKey;
let k2: TestKey;
let stranger: TestKey;

beforeAll(async () => {
  [k1, k2, stranger] = await Promise.all([makeKey('kid-1'), makeKey('kid-2'), makeKey('kid-1')]);
});

function setup(over: Partial<AccessVerifierOptions> = {}, keys = [k1]) {
  const jwks = fakeJwks(keys);
  let t = Date.now();
  const verifier = createAccessVerifier({ teamDomain: TEAM, audiences: ['other-aud', AUD], fetch: jwks.fetch, now: () => t, ...over });
  return { verifier, jwks, advance: (ms: number) => (t += ms) };
}

describe('createAccessVerifier', () => {
  it('accepts a valid assertion and lower-cases the email', async () => {
    const { verifier, jwks } = setup();
    const r = await verifier.verify(await signRs256(k1, claims({ email: 'Person@Example.COM', aud: AUD })));
    expect(r).toEqual({ ok: true, identity: { email: 'person@example.com', sub: 'cf-sub-1', name: undefined } });
    expect(jwks.state.urls).toEqual([`https://${TEAM}/cdn-cgi/access/certs`]);
  });

  it('caches keys: a second token does not refetch', async () => {
    const { verifier, jwks } = setup();
    await verifier.verify(await signRs256(k1, claims()));
    await verifier.verify(await signRs256(k1, claims()));
    expect(jwks.state.calls).toBe(1);
  });

  it('rejects a wrong aud', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(await signRs256(k1, claims({ aud: ['someone-else'] })))).toEqual({ ok: false, reason: 'aud' });
  });

  it('rejects a wrong iss (exact match only)', async () => {
    const { verifier } = setup();
    for (const iss of ['https://evil.cloudflareaccess.com', `https://${TEAM}/`, `http://${TEAM}`, TEAM]) {
      expect(await verifier.verify(await signRs256(k1, claims({ iss })))).toEqual({ ok: false, reason: 'iss' });
    }
  });

  it('rejects an expired token (beyond the skew) and a future nbf/iat', async () => {
    const { verifier } = setup();
    const now = Math.floor(Date.now() / 1000);
    expect(await verifier.verify(await signRs256(k1, claims({ exp: now - 120 })))).toEqual({ ok: false, reason: 'expired' });
    expect((await verifier.verify(await signRs256(k1, claims({ exp: now - 10 })))).ok).toBe(true); // within skew
    expect(await verifier.verify(await signRs256(k1, claims({ exp: undefined })))).toEqual({ ok: false, reason: 'expired' });
    expect(await verifier.verify(await signRs256(k1, claims({ nbf: now + 600 })))).toEqual({ ok: false, reason: 'not_yet_valid' });
    expect(await verifier.verify(await signRs256(k1, claims({ iat: now + 600 })))).toEqual({ ok: false, reason: 'iat' });
  });

  it('rejects a bad signature (same kid, other key) and a tampered payload', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(await signRs256(stranger, claims()))).toEqual({ ok: false, reason: 'signature' });
    const good = await signRs256(k1, claims());
    const [h, , s] = good.split('.');
    const forged = Buffer.from(JSON.stringify(claims({ email: 'boss@example.com' }))).toString('base64url');
    expect(await verifier.verify(`${h}.${forged}.${s}`)).toEqual({ ok: false, reason: 'signature' });
  });

  it('rejects alg none', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(unsigned('kid-1', claims()))).toEqual({ ok: false, reason: 'alg' });
  });

  it('rejects HS256 signed with the public key (algorithm confusion)', async () => {
    const { verifier, jwks } = setup();
    expect(await verifier.verify(signHs256WithPublicKey(k1, claims()))).toEqual({ ok: false, reason: 'alg' });
    expect(jwks.state.calls).toBe(0);
  });

  it('rejects a token without kid', async () => {
    const { verifier } = setup();
    expect(await verifier.verify(await signRs256(k1, claims(), { kid: undefined }))).toEqual({ ok: false, reason: 'kid' });
  });

  it('rejects a service-token assertion (common_name, no email)', async () => {
    const { verifier } = setup();
    const svc = claims({ email: '', common_name: 'abc123.access', sub: '' });
    expect(await verifier.verify(await signRs256(k1, svc))).toEqual({ ok: false, reason: 'service_token' });
    const noEmail = claims({ email: undefined });
    expect(await verifier.verify(await signRs256(k1, noEmail))).toEqual({ ok: false, reason: 'no_email' });
  });

  it('rejects garbage', async () => {
    const { verifier } = setup();
    for (const t of ['', 'a.b', 'a.b.c.d', '!!.??.**', 'x'.repeat(20_000)]) {
      expect((await verifier.verify(t)).ok).toBe(false);
    }
  });

  it('unknown kid triggers exactly one refetch (then the cooldown holds)', async () => {
    const { verifier, jwks, advance } = setup();
    expect((await verifier.verify(await signRs256(k1, claims()))).ok).toBe(true);
    expect(jwks.state.calls).toBe(1);
    advance(11_000);
    const unknown = await signRs256(k2, claims());
    expect(await verifier.verify(unknown)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(jwks.state.calls).toBe(2);
    expect(await verifier.verify(unknown)).toEqual({ ok: false, reason: 'unknown_key' });
    expect(jwks.state.calls).toBe(2);
  });

  it('a rotated key is picked up by that one refetch', async () => {
    const { verifier, jwks, advance } = setup();
    await verifier.verify(await signRs256(k1, claims()));
    jwks.state.keys = [k1, k2];
    advance(11_000);
    expect((await verifier.verify(await signRs256(k2, claims()))).ok).toBe(true);
    expect(jwks.state.calls).toBe(2);
  });

  it('refetches after the cache TTL', async () => {
    const { verifier, jwks, advance } = setup({ cacheTtlMs: 1000 });
    await verifier.verify(await signRs256(k1, claims()));
    advance(1500);
    await verifier.verify(await signRs256(k1, claims()));
    expect(jwks.state.calls).toBe(2);
  });

  it('JWKS fetch failure fails closed (cold and after TTL)', async () => {
    const { verifier, jwks, advance } = setup({ cacheTtlMs: 1000 });
    jwks.state.fail = true;
    expect(await verifier.verify(await signRs256(k1, claims()))).toEqual({ ok: false, reason: 'unknown_key' });
    jwks.state.fail = false;
    expect((await verifier.verify(await signRs256(k1, claims()))).ok).toBe(true);
    advance(1500);
    jwks.state.fail = true;
    expect(await verifier.verify(await signRs256(k1, claims()))).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('a non-200 JWKS or a hung endpoint fails closed', async () => {
    const bad = createAccessVerifier({
      teamDomain: TEAM,
      audiences: [AUD],
      fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    expect((await bad.verify(await signRs256(k1, claims()))).ok).toBe(false);
    const hung = createAccessVerifier({
      teamDomain: TEAM,
      audiences: [AUD],
      timeoutMs: 50,
      fetch: ((_: unknown, init?: RequestInit) =>
        new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch,
    });
    expect((await hung.verify(await signRs256(k1, claims()))).ok).toBe(false);
  });

  it('uses the certs URL override when given', async () => {
    const { verifier, jwks } = setup({ certsUrl: 'http://127.0.0.1:9/certs' });
    await verifier.verify(await signRs256(k1, claims()));
    expect(jwks.state.urls).toEqual(['http://127.0.0.1:9/certs']);
  });
});
