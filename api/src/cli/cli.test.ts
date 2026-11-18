import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from '@shared/zod';

import { defineOperation, EXPOSE_ALL, EXPOSE_NO_MCP } from '@shared/operation-contract';
import { getAccessToken, runCli } from './index';
import { CredentialStore, resolveConfigDir } from './credentials';

const list = defineOperation({
  name: 'demo_items_list',
  description: 'List items of a box. Newest first.',
  input: z.object({
    box_id: z.string().describe('Box id'),
    limit: z.number().int().optional(),
    kind: z.enum(['a', 'b']).optional(),
    archived: z.boolean().optional(),
  }),
  method: 'GET',
  path: '/boxes/:box_id/items',
  kind: 'read',
  expose: EXPOSE_ALL,
});
const create = defineOperation({
  name: 'demo_items_create',
  description: 'Create an item.',
  input: z.object({
    box_id: z.string(),
    title: z.string(),
    tags: z.array(z.string()).optional(),
    amount: z.number().optional(),
    done: z.boolean().optional().default(false),
  }),
  method: 'POST',
  path: '/boxes/:box_id/items',
  kind: 'write',
  expose: EXPOSE_ALL,
});
const wipe = defineOperation({
  name: 'demo_boxes_delete',
  description: 'Delete a box.',
  input: z.object({ box_id: z.string() }),
  method: 'DELETE',
  path: '/boxes/:box_id',
  kind: 'destructive',
  expose: EXPOSE_NO_MCP,
});
const hidden = defineOperation({
  name: 'demo_secret_op',
  description: 'Not for the CLI.',
  input: z.object({}),
  method: 'GET',
  path: '/secret',
  kind: 'read',
  expose: { api: true, cli: false, mcp: true },
});
const contracts = [list, create, wipe, hidden];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'budget-cli-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: string;
}
function harness(respond: (req: Request) => Response | Promise<Response> = () => Response.json({ ok: 1 })) {
  const seen: Seen[] = [];
  const o = { out: '', err: '' };
  const fetch = async (req: Request) => {
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.get('authorization'),
      body: await req.clone().text(),
    });
    return respond(req);
  };
  const run = (argv: string[]) =>
    runCli({
      contracts,
      argv,
      defaultApiUrl: 'http://api.test',
      configDir: dir,
      stdout: (s) => (o.out += s),
      stderr: (s) => (o.err += s),
      fetch,
      openBrowser: () => undefined,
    });
  return { seen, o, run };
}

describe('command generation', () => {
  it('derives command paths from names and skips non-cli operations', async () => {
    const h = harness();
    expect(await h.run(['--help'])).toBe(0);
    expect(h.o.out).toContain('demo');
    expect(h.o.out).not.toContain('secret');
    const g = harness();
    expect(await g.run(['demo', '--help'])).toBe(0);
    expect(g.o.out).toContain('items');
    expect(g.o.out).toContain('boxes');
  });

  it('leaf help is generated from description and schema', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'list', '--help'])).toBe(0);
    expect(h.o.out).toContain('List items of a box.');
    expect(h.o.out).toContain('--box-id <string>');
    expect(h.o.out).toContain('(required)');
    expect(h.o.out).toContain('Box id');
    expect(h.o.out).toContain('--kind <a|b>');
    expect(h.o.out).toContain('--limit <integer>');
    expect(h.o.out).not.toContain('--dry-run');
    const w = harness();
    await w.run(['demo', 'boxes', 'delete', '--help']);
    expect(w.o.out).toContain('--dry-run');
    expect(w.o.out).toContain('--yes');
  });
});

describe('request building', () => {
  it('routes flags to path and query', async () => {
    const h = harness();
    expect(
      await h.run(['demo', 'items', 'list', '--box-id', 'b1', '--limit', '5', '--kind=a', '--archived', '--json']),
    ).toBe(0);
    expect(h.seen[0]!.method).toBe('GET');
    const u = new URL(h.seen[0]!.url);
    expect(u.pathname).toBe('/boxes/b1/items');
    expect(u.searchParams.get('limit')).toBe('5');
    expect(u.searchParams.get('kind')).toBe('a');
    expect(u.searchParams.get('archived')).toBe('true');
    expect(JSON.parse(h.o.out)).toEqual({ ok: 1 });
  });

  it('routes body keys, merges --input with flags winning, supports --no-bool', async () => {
    const h = harness();
    const code = await h.run([
      'demo',
      'items',
      'create',
      '--input',
      '{"box_id":"x","title":"from-input","tags":["t1"]}',
      '--title',
      'from-flag',
      '--box-id',
      'b2',
      '--no-done',
    ]);
    expect(code).toBe(0);
    expect(h.seen[0]!.url).toBe('http://api.test/boxes/b2/items');
    expect(JSON.parse(h.seen[0]!.body)).toEqual({
      title: 'from-flag',
      tags: ['t1'],
      done: false,
    });
  });

  it('json flag carries complex values', async () => {
    const h = harness();
    await h.run(['demo', 'items', 'create', '--box-id', 'b', '--title', 't', '--tags', '["a","b"]', '--amount=-5']);
    expect(JSON.parse(h.seen[0]!.body)).toMatchObject({
      tags: ['a', 'b'],
      amount: -5,
    });
  });

  it('--api-url overrides the default, also before the command', async () => {
    const h = harness();
    await h.run(['--api-url', 'http://other.test/', 'demo', 'items', 'list', '--box-id', 'b']);
    expect(h.seen[0]!.url).toStartWith('http://other.test/boxes/b/items');
  });

  it('prints a human table by default', async () => {
    const h = harness(() =>
      Response.json([
        { id: 1, title: 'one' },
        { id: 2, title: 'two' },
      ]),
    );
    await h.run(['demo', 'items', 'list', '--box-id', 'b']);
    expect(h.o.out).toContain('title');
    expect(h.o.out).toContain('two');
    expect(h.o.out).not.toContain('{');
  });
});

describe('usage errors (exit 2)', () => {
  it('missing required flag', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'list'])).toBe(2);
    expect(h.o.err).toContain('--box-id');
    expect(h.seen).toHaveLength(0);
  });
  it('unknown flag, bad number, bad enum, unknown command, bad --input', async () => {
    for (const argv of [
      ['demo', 'items', 'list', '--box-id', 'b', '--nope', '1'],
      ['demo', 'items', 'list', '--box-id', 'b', '--limit', 'abc'],
      ['demo', 'items', 'list', '--box-id', 'b', '--limit', '1.5'],
      ['demo', 'items', 'list', '--box-id', 'b', '--kind', 'z'],
      ['demo', 'nothing'],
      ['demo', 'items', 'list', '--input', '{bad'],
      ['demo', 'items', 'list', '--input', '{"box_id":"b","extra":1}'],
    ]) {
      const h = harness();
      expect(await h.run(argv)).toBe(2);
      expect(h.seen).toHaveLength(0);
    }
  });
  it('rejects path traversal and control characters', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'list', '--box-id', '../x'])).toBe(2);
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'a\u0001b'])).toBe(2);
    expect(await h.run(['demo', 'items', 'list', '--input', '{"box_id":"a/b"}'])).toBe(2);
  });
  it('errors are JSON on stderr with --json', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'list', '--json'])).toBe(2);
    expect(JSON.parse(h.o.err).error.code).toBe('usage');
  });
});

describe('dry-run and destructive', () => {
  it('dry-run sends nothing and prints the request', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'create', '--box-id', 'b', '--title', 'T', '--dry-run', '--json'])).toBe(0);
    expect(h.seen).toHaveLength(0);
    const r = JSON.parse(h.o.out);
    expect(r).toMatchObject({
      dry_run: true,
      method: 'POST',
      url: 'http://api.test/boxes/b/items',
      body: { title: 'T' },
    });
  });
  it('read operations have no --dry-run', async () => {
    const h = harness();
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'b', '--dry-run'])).toBe(2);
  });
  it('destructive refuses without --yes, runs with it, previews with --dry-run', async () => {
    const h = harness();
    expect(await h.run(['demo', 'boxes', 'delete', '--box-id', 'b'])).toBe(2);
    expect(h.o.err).toContain('--yes');
    expect(h.seen).toHaveLength(0);
    expect(await h.run(['demo', 'boxes', 'delete', '--box-id', 'b', '--dry-run'])).toBe(0);
    expect(h.seen).toHaveLength(0);
    expect(await h.run(['demo', 'boxes', 'delete', '--box-id', 'b', '--yes'])).toBe(0);
    expect(h.seen[0]!.method).toBe('DELETE');
  });
});

describe('API errors (exit 1)', () => {
  it('maps non-2xx to exit 1 with the server message', async () => {
    const h = harness(() => Response.json({ error: 'nope' }, { status: 404 }));
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'b', '--json'])).toBe(1);
    const e = JSON.parse(h.o.err).error;
    expect(e).toMatchObject({
      code: 'api_error',
      status: 404,
      message: 'nope',
    });
  });
  it('network failure is exit 1', async () => {
    const h = harness(() => {
      throw new TypeError('fetch failed');
    });
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'b'])).toBe(1);
  });
});

describe('schema', () => {
  it('lists operations and prints a JSON schema', async () => {
    const l = harness();
    expect(await l.run(['schema', '--json'])).toBe(0);
    const rows = JSON.parse(l.o.out);
    expect(rows.map((r: { operation: string }) => r.operation)).toEqual([
      'demo_items_list',
      'demo_items_create',
      'demo_boxes_delete',
    ]);
    expect(rows[2].kind).toBe('destructive');
    const s = harness();
    expect(await s.run(['schema', 'demo_items_list'])).toBe(0);
    const schema = JSON.parse(s.o.out);
    expect(schema.required).toEqual(['box_id']);
    expect(schema.properties.kind.enum).toEqual(['a', 'b']);
    const s2 = harness();
    expect(await s2.run(['schema', 'demo', 'items', 'list'])).toBe(0);
    expect(JSON.parse(s2.o.out).title).toBe('demo_items_list');
    expect(await harness().run(['schema', 'nope'])).toBe(2);
  });
});

describe('credential store', () => {
  it('writes 0600 file in 0700 dir, keyed by normalized URL, atomically', () => {
    const cfg = join(dir, 'cfg', 'budget');
    const store = new CredentialStore(cfg);
    store.save('http://api.test/', {
      client_id: 'c',
      access_token: 'a',
      expires_at: 1,
      refresh_token: 'r',
    });
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
    expect(statSync(cfg).mode & 0o777).toBe(0o700);
    expect(store.get('http://api.test')?.client_id).toBe('c');
    expect(Object.keys(JSON.parse(readFileSync(store.file, 'utf8')).servers)).toEqual(['http://api.test']);
    store.delete('http://api.test');
    expect(store.get('http://api.test')).toBeUndefined();
  });
  it('honours XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/x/y', HOME: '/h' })).toBe('/x/y/budget');
    expect(resolveConfigDir({ HOME: '/h' })).toBe('/h/.config/budget');
  });
});

describe('token refresh', () => {
  const asServer =
    (calls: string[], mode: 'ok' | 'invalid_grant' = 'ok') =>
    async (req: Request) => {
      const u = new URL(req.url);
      if (u.pathname.endsWith('oauth-authorization-server')) return new Response('', { status: 404 });
      calls.push(await req.text());
      if (mode === 'invalid_grant') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        access_token: 'new-access',
        refresh_token: 'rotated',
        expires_in: 900,
        scope: 'read write',
      });
    };

  it('returns the stored token when fresh, undefined when logged out', async () => {
    expect(await getAccessToken({ apiUrl: 'http://api.test', configDir: dir })).toBeUndefined();
    new CredentialStore(dir).save('http://api.test', {
      client_id: 'c',
      access_token: 'live',
      expires_at: Date.now() + 600_000,
      refresh_token: 'r',
    });
    expect(await getAccessToken({ apiUrl: 'http://api.test', configDir: dir })).toBe('live');
  });

  it('refreshes when expired and persists the rotated token before returning', async () => {
    const store = new CredentialStore(dir);
    store.save('http://api.test', {
      client_id: 'c',
      access_token: 'old',
      expires_at: Date.now() - 1000,
      refresh_token: 'r1',
    });
    const calls: string[] = [];
    const tok = await getAccessToken({
      apiUrl: 'http://api.test',
      configDir: dir,
      fetch: asServer(calls),
    });
    expect(tok).toBe('new-access');
    expect(calls[0]).toContain('grant_type=refresh_token');
    expect(calls[0]).toContain('refresh_token=r1');
    const saved = store.get('http://api.test')!;
    expect(saved.refresh_token).toBe('rotated');
    expect(saved.access_token).toBe('new-access');
    expect(statSync(store.file).mode & 0o777).toBe(0o600);
  });

  it('refreshes inside the expiry skew window', async () => {
    new CredentialStore(dir).save('http://api.test', {
      client_id: 'c',
      access_token: 'old',
      expires_at: Date.now() + 10_000,
      refresh_token: 'r1',
    });
    expect(
      await getAccessToken({
        apiUrl: 'http://api.test',
        configDir: dir,
        fetch: asServer([]),
      }),
    ).toBe('new-access');
  });

  it('invalid_grant clears credentials and tells the user to log in', async () => {
    const store = new CredentialStore(dir);
    store.save('http://api.test', {
      client_id: 'c',
      access_token: 'old',
      expires_at: 0,
      refresh_token: 'r1',
    });
    const h = harness(asServer([], 'invalid_grant'));
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'b'])).toBe(1);
    expect(h.o.err).toContain('budget login');
    expect(store.get('http://api.test')).toBeUndefined();
  });

  it('an API call sends the refreshed bearer', async () => {
    new CredentialStore(dir).save('http://api.test', {
      client_id: 'c',
      access_token: 'old',
      expires_at: 0,
      refresh_token: 'r1',
    });
    const h = harness((req) =>
      req.url.includes('/oauth/token')
        ? Response.json({
            access_token: 'new-access',
            refresh_token: 'r2',
            expires_in: 900,
          })
        : Response.json([]),
    );
    expect(await h.run(['demo', 'items', 'list', '--box-id', 'b'])).toBe(0);
    expect(h.seen.at(-1)!.auth).toBe('Bearer new-access');
  });
});

describe('login / logout', () => {
  function fakeServer() {
    const st = {
      registered: undefined as { redirect_uris: string[] } | undefined,
      challenge: '',
      revoked: [] as string[],
      tokenBodies: [] as URLSearchParams[],
    };
    const fetchImpl = async (req: Request): Promise<Response> => {
      if (req.url.includes('127.0.0.1')) return fetch(req); // the loopback listener
      const u = new URL(req.url);
      if (u.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: 'http://api.test',
          authorization_endpoint: 'http://api.test/oauth/authorize',
          token_endpoint: 'http://api.test/oauth/token',
          registration_endpoint: 'http://api.test/oauth/register',
          revocation_endpoint: 'http://api.test/oauth/revoke',
        });
      }
      if (u.pathname === '/oauth/register') {
        st.registered = JSON.parse(await req.text());
        return Response.json({ client_id: 'client-1' }, { status: 201 });
      }
      if (u.pathname === '/oauth/token') {
        const p = new URLSearchParams(await req.text());
        st.tokenBodies.push(p);
        const ok =
          createHash('sha256').update(p.get('code_verifier')!).digest('base64url') === st.challenge &&
          p.get('code') === 'the-code';
        return ok
          ? Response.json({
              access_token: 'acc',
              refresh_token: 'ref',
              expires_in: 900,
              scope: 'read write',
            })
          : Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      if (u.pathname === '/oauth/revoke') {
        st.revoked.push(new URLSearchParams(await req.text()).get('token')!);
        return new Response(null, { status: 200 });
      }
      return Response.json({});
    };
    return { st, fetchImpl };
  }
  const cli = (argv: string[], fetchImpl: (r: Request) => Promise<Response>, openBrowser?: (u: string) => void) => {
    const o = { out: '', err: '' };
    const code = runCli({
      contracts,
      argv,
      defaultApiUrl: 'http://api.test',
      configDir: dir,
      stdout: (s) => (o.out += s),
      stderr: (s) => (o.err += s),
      fetch: fetchImpl,
      openBrowser,
      loginTimeoutMs: 3000,
    });
    return { o, code };
  };

  it('authorization code + PKCE over a loopback listener, then logout revokes and deletes', async () => {
    const { st, fetchImpl } = fakeServer();
    const browse = (url: string) => {
      const a = new URL(url);
      st.challenge = a.searchParams.get('code_challenge')!;
      expect(a.searchParams.get('code_challenge_method')).toBe('S256');
      expect(a.searchParams.get('redirect_uri')).toBe(st.registered!.redirect_uris[0]!);
      const cb = new URL(a.searchParams.get('redirect_uri')!);
      cb.searchParams.set('code', 'the-code');
      cb.searchParams.set('state', a.searchParams.get('state')!);
      cb.searchParams.set('iss', 'http://api.test');
      void fetch(cb);
    };
    const { o, code } = cli(['login', '--json'], fetchImpl, browse);
    expect(await code).toBe(0);
    expect(st.registered!.redirect_uris[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(o.err).toContain('http://api.test/oauth/authorize?');
    expect(o.out).not.toContain('acc');
    expect(JSON.parse(o.out)).toMatchObject({
      logged_in: true,
      scope: 'read write',
    });
    const store = new CredentialStore(dir);
    expect(store.get('http://api.test')).toMatchObject({
      client_id: 'client-1',
      access_token: 'acc',
      refresh_token: 'ref',
    });
    expect(st.tokenBodies[0]!.get('redirect_uri')).toBe(st.registered!.redirect_uris[0]!);

    const out = cli(['logout', '--json'], fetchImpl);
    expect(await out.code).toBe(0);
    expect(st.revoked).toEqual(['ref']);
    expect(store.get('http://api.test')).toBeUndefined();
    expect(JSON.parse(out.o.out)).toMatchObject({
      was_logged_in: true,
      revoked: true,
    });
  });

  it('ignores a callback with a wrong state and fails on access_denied', async () => {
    const { st, fetchImpl } = fakeServer();
    const browse = async (url: string) => {
      const a = new URL(url);
      st.challenge = a.searchParams.get('code_challenge')!;
      const cb = new URL(a.searchParams.get('redirect_uri')!);
      const bad = new URL(cb);
      bad.searchParams.set('code', 'evil');
      bad.searchParams.set('state', 'wrong');
      expect((await fetch(bad)).status).toBe(400);
      cb.searchParams.set('error', 'access_denied');
      cb.searchParams.set('state', a.searchParams.get('state')!);
      void fetch(cb);
    };
    const { o, code } = cli(['login'], fetchImpl, browse);
    expect(await code).toBe(1);
    expect(o.err).toContain('access_denied');
    expect(new CredentialStore(dir).get('http://api.test')).toBeUndefined();
  });

  it('times out when nobody completes the sign-in', async () => {
    const { fetchImpl } = fakeServer();
    const o = { out: '', err: '' };
    const code = await runCli({
      contracts,
      argv: ['login'],
      defaultApiUrl: 'http://api.test',
      configDir: dir,
      stdout: (s) => (o.out += s),
      stderr: (s) => (o.err += s),
      fetch: fetchImpl,
      openBrowser: () => undefined,
      loginTimeoutMs: 100,
    });
    expect(code).toBe(1);
    expect(o.err).toContain('Timed out');
  });

  it('whoami uses the stored token', async () => {
    new CredentialStore(dir).save('http://api.test', {
      client_id: 'c',
      access_token: 'live',
      expires_at: Date.now() + 600_000,
      refresh_token: 'r',
    });
    const h = harness(() => Response.json({ email: 'me@x.com' }));
    expect(await h.run(['whoami', '--json'])).toBe(0);
    expect(h.seen[0]).toMatchObject({
      url: 'http://api.test/auth/me',
      auth: 'Bearer live',
    });
    expect(JSON.parse(h.o.out)).toEqual({ email: 'me@x.com' });
  });
});
