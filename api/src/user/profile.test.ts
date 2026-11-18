import { beforeEach, describe, expect, it } from 'bun:test';
import { Hono } from 'hono';
import { deflateSync } from 'node:zlib';

import { pool } from '../core/db';
import { dbReady } from '../core/test-gate';
import { httpOnError } from '../core/validate';
import { personAvatarSql, toPersonAvatar, type PersonAvatarRow } from './avatar';
import { requireUser } from './middleware';
import { sniffImageFormat } from './image';
import routes from './routes';
import { provisionUserByEmail, resolveOrCreateSessionUser } from './store';
import { configureAuth } from './config';

const reachable = dbReady;

/** Dev-bypass app (no auth env): requireUser resolves the synthetic dev user. */
function devApp() {
  const app = new Hono();
  app.use('*', requireUser);
  app.route('/', routes);
  app.onError(httpOnError);
  return app;
}

/** Minimal valid RGB PNG, w x h, as a gradient. */
function makePng(w: number, h: number): Uint8Array {
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * stride + 1 + x * 3;
      raw[o] = x % 256;
      raw[o + 1] = y % 256;
      raw[o + 2] = 128;
    }
  }
  const table: number[] = [];
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  const crc = (b: Buffer) => {
    let r = ~0;
    for (const x of b) r = table[(r ^ x) & 255] ^ (r >>> 8);
    return ~r >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

const put = (app: Hono, body: Uint8Array, type = 'image/png') =>
  app.request('/me/avatar', { method: 'PUT', headers: { 'Content-Type': type }, body: body as BodyInit });
const patch = (app: Hono, body: unknown) =>
  app.request('/me', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

beforeEach(async () => {
  if (reachable) {
    await pool.query('alter table public.budgets alter column owner_user_id drop not null');
    await pool.query('update public.budgets set owner_user_id = null where owner_user_id in (select id from public.users)');
    await pool.query('delete from public.users');
  }
  configureAuth({ authDisabled: true });
});

describe('avatar contract (pure)', () => {
  it('maps the SQL columns to the PersonAvatar shape', () => {
    const row: PersonAvatarRow = { avatar_seed: 'abc', avatar_image_version: 3 };
    expect(toPersonAvatar(row)).toEqual({ seed: 'abc', image_version: 3 });
    expect(toPersonAvatar({ avatar_seed: 'x', avatar_image_version: null }).image_version).toBeNull();
  });

  it('rejects non-identifier aliases', () => {
    expect(() => personAvatarSql('u; drop table users')).toThrow();
    expect(personAvatarSql('u')).toContain('u.avatar_seed');
  });

  it('sniffs magic bytes, not content type', () => {
    expect(sniffImageFormat(makePng(2, 2))).toBe('png');
    expect(sniffImageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpeg');
    expect(sniffImageFormat(new TextEncoder().encode('<svg xmlns=...'))).toBeNull();
    expect(sniffImageFormat(new TextEncoder().encode('RIFF....WEBPVP8 '))).toBe('webp');
  });
});

describe.skipIf(!reachable)('GET/PATCH /me', () => {
  it('fresh user: seed is the user id, no photo', async () => {
    const res = await devApp().request('/me');
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.email).toBe('dev@localhost');
    expect(me.role).toBe('admin');
    expect(me.avatar).toEqual({ seed: me.id, image_version: null });
  });

  it('PATCH name trims and persists; rejects empty / too long / unknown keys', async () => {
    const app = devApp();
    const ok = await patch(app, { name: '  Yuri R  ' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).name).toBe('Yuri R');
    expect((await (await app.request('/me')).json()).name).toBe('Yuri R');
    expect((await patch(app, { name: '   ' })).status).toBe(400);
    expect((await patch(app, { name: 'x'.repeat(81) })).status).toBe(400);
    // undeclared keys are never read: a role escalation attempt is a no-op
    const sneaky = await (await patch(app, { role: 'admin', name: 'Still Me' })).json();
    expect(sneaky.name).toBe('Still Me');
  });

  it('PATCH avatar_seed picks a look; null restores the default', async () => {
    const app = devApp();
    const me = await (await app.request('/me')).json();
    const picked = await (await patch(app, { avatar_seed: 'otter-42' })).json();
    expect(picked.avatar.seed).toBe('otter-42');
    const reset = await (await patch(app, { avatar_seed: null })).json();
    expect(reset.avatar.seed).toBe(me.id);
  });

  it('a user-edited name survives the next Google sign-in', async () => {
    const first = await resolveOrCreateSessionUser('p@x.com', { sub: 's1', name: 'Google Name' });
    await pool.query('update public.users set name = $2 where id = $1', [first.id, 'My Own Name']);
    const again = await resolveOrCreateSessionUser('p@x.com', { sub: 's1', name: 'Google Name' });
    expect(again.name).toBe('My Own Name');
  });

  it('a pre-provisioned user already has an avatar shape', async () => {
    const p = await provisionUserByEmail('invitee@x.com');
    const { rows } = await pool.query<PersonAvatarRow>(
      `select ${personAvatarSql('u')} from public.users u where u.id = $1`,
      [p.id],
    );
    expect(toPersonAvatar(rows[0])).toEqual({ seed: p.id, image_version: null });
  });
});

describe.skipIf(!reachable)('OAuth principals are read-only on the profile', () => {
  /** Dev-bypass app with a scoped (OAuth-style) principal injected before requireUser. */
  function oauthApp(scope: string) {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('principal', { email: 'dev@localhost', scope, grantId: 'g' });
      await next();
    });
    app.use('*', requireUser);
    app.route('/', routes);
    app.onError(httpOnError);
    return app;
  }

  it('may read /me but never mutate name, photo or look, even with write scope', async () => {
    const app = oauthApp('read write');
    expect((await app.request('/me')).status).toBe(200);
    expect((await patch(app, { name: 'Hacked' })).status).toBe(403);
    expect((await put(app, makePng(8, 8))).status).toBe(403);
    expect((await app.request('/me/avatar', { method: 'DELETE' })).status).toBe(403);
  });
});

describe.skipIf(!reachable)('avatar photo', () => {
  it('upload normalizes to webp, bumps version, serves bytes with cache headers', async () => {
    const app = devApp();
    const res = await put(app, makePng(600, 400));
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me.avatar.image_version).toBe(1);

    const got = await app.request(`/users/${me.id}/avatar?v=1`);
    expect(got.status).toBe(200);
    expect(got.headers.get('content-type')).toBe('image/webp');
    expect(got.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    expect(got.headers.get('etag')).toBe('"av1"');
    const bytes = new Uint8Array(await got.arrayBuffer());
    const meta = await new Bun.Image(bytes).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width, meta.height)).toBe(256);

    const cond = await app.request(`/users/${me.id}/avatar?v=1`, { headers: { 'If-None-Match': '"av1"' } });
    expect(cond.status).toBe(304);

    const again = await (await put(app, makePng(64, 64))).json();
    expect(again.avatar.image_version).toBe(2);

    const bare = await app.request(`/users/${me.id}/avatar`);
    expect(bare.headers.get('cache-control')).toBe('private, no-cache');
  });

  it('rejects bad magic bytes (even with an image content type), oversize and garbage', async () => {
    const app = devApp();
    expect((await put(app, new TextEncoder().encode('<svg onload=alert(1)>'), 'image/png')).status).toBe(400);
    expect((await put(app, new Uint8Array(0))).status).toBe(400);
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big.set([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await put(app, big)).status).toBe(413);
    // valid PNG signature, corrupt body
    const corrupt = new Uint8Array(200);
    corrupt.set([137, 80, 78, 71, 13, 10, 26, 10]);
    expect((await put(app, corrupt)).status).toBe(400);
    const me = await (await app.request('/me')).json();
    expect(me.avatar.image_version).toBeNull();
  });

  it('DELETE and picking a generated look both restore the generated avatar', async () => {
    const app = devApp();
    const me = await (await put(app, makePng(40, 40))).json();
    const del = await app.request('/me/avatar', { method: 'DELETE' });
    expect((await del.json()).avatar.image_version).toBeNull();
    expect((await app.request(`/users/${me.id}/avatar`)).status).toBe(404);

    await put(app, makePng(40, 40));
    const picked = await (await patch(app, { avatar_seed: 'fox' })).json();
    expect(picked.avatar).toEqual({ seed: 'fox', image_version: null });
    // version keeps moving forward so a later re-upload never reuses a cached URL
    const reup = await (await put(app, makePng(40, 40))).json();
    expect(reup.avatar.image_version).toBeGreaterThan(2);
  });

  it('GET /users/:id/avatar validates the id and 404s without a photo', async () => {
    const app = devApp();
    const me = await (await app.request('/me')).json();
    expect((await app.request(`/users/${me.id}/avatar`)).status).toBe(404);
    expect((await app.request('/users/not-a-uuid/avatar')).status).toBe(400);
  });
});
