/**
 * Features: evaluation against the real table (isEnabled, evaluateFeatures)
 * and the routes end to end through the composed app (buildApp, real auth
 * gate, real sessions): GET /features for any signed-in user, /admin/features
 * for admins with a first-party session only.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import { adminFeatureSchema, contracts, myFeaturesSchema } from '@shared/contracts/features';
import { FEATURES, FEATURE_KEYS, type FeatureKey } from '@shared/features';
import { buildApp } from '../app';
import { pool } from '../core/db';
import { MIGRATION_SIGNATURES } from '../core/migrate';
import { dbReady } from '../core/test-gate';
import { defaultOAuthTtls } from '../oauth';
import { configureAuth, issueAccessToken, issueSession } from '../user';
import { evaluateFeatures, isEnabled, operations } from './index';
import { setEveryoneValue, setUserValue } from './store';

const SECRET = 'f'.repeat(40);
const API = 'https://api.test';
const APP = 'https://app.test';
const ADMIN_ORIGIN = 'https://admin.test';
const SVC_TOKEN = 'svc-token-for-features-tests-0123456789';
const D = '@featurestest.test';
const KEY: FeatureKey = 'shared-pluggy-key'; // default off
const DEFAULTS = { 'shared-pluggy-key': false, 'shared-jev-key': false } as const;
const RETIRED = 'features-test-retired-key';

const dbTest = test.skipIf(!dbReady);

const app = () =>
  buildApp({
    appOrigin: APP,
    adminOrigins: [ADMIN_ORIGIN],
    version: 't',
    oauth: { ...defaultOAuthTtls, issuer: API, resource: `${API}/mcp`, secret: SECRET, devEmail: null },
  });

type Who = { id: string; email: string; cookie: Record<string, string> };

async function makeUser(local: string, role: 'admin' | 'user' = 'user'): Promise<Who> {
  const email = `${local}${D}`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into public.users (id, email, name, role, signed_in_at) values (gen_random_uuid(), $1, $2, $3, now()) returning id`,
    [email, local, role],
  );
  return { id: rows[0]!.id, email, cookie: { cookie: `budget_session=${await issueSession(SECRET, email, 600)}` } };
}

async function send(method: string, path: string, headers: Record<string, string> = {}, body?: unknown) {
  const res = await app().request(`${API}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, res };
}

async function cleanup() {
  if (!dbReady) return;
  await pool.query('delete from public.feature_overrides where feature_key = any($1::text[])', [[...FEATURE_KEYS, RETIRED]]);
  await pool.query('delete from public.users where email like $1', [`%${D}`]);
}

let admin: Who;
let ann: Who;
let bob: Who;

beforeAll(cleanup);
beforeEach(async () => {
  await cleanup();
  if (!dbReady) return;
  admin = await makeUser('admin', 'admin');
  ann = await makeUser('ann');
  bob = await makeUser('bob');
  configureAuth({
    sessionSecret: SECRET,
    apiBaseUrl: API,
    appOrigin: APP,
    allowedEmails: [admin.email, ann.email, bob.email],
    serviceToken: SVC_TOKEN,
  });
});
afterAll(async () => {
  await cleanup();
  configureAuth({ authDisabled: true });
});

describe('features module surface', () => {
  test('serves exactly the features contracts', () => {
    expect(new Set(operations.map((o) => o.contract))).toEqual(new Set(contracts));
  });

  test('migration 0103 is registered with the table as its signature', () => {
    expect(MIGRATION_SIGNATURES['0103_feature_overrides.sql']).toBe('table:public.feature_overrides');
  });
});

describe('isEnabled (database)', () => {
  dbTest('the table exists with who and when on each row', async () => {
    const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
      `select column_name, is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'feature_overrides' order by column_name`,
    );
    expect(Object.fromEntries(rows.map((r) => [r.column_name, r.is_nullable]))).toEqual({
      changed_at: 'NO',
      changed_by: 'YES',
      feature_key: 'NO',
      id: 'NO',
      user_id: 'YES',
      value: 'NO',
    });
  });

  dbTest('nothing stored: the default in code', async () => {
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
    expect(await isEnabled(pool, KEY, null)).toBe(false);
    expect(await evaluateFeatures(pool, ann.id)).toEqual(DEFAULTS);
  });

  dbTest('the everyone value beats the default, for every user and for no user', async () => {
    await setEveryoneValue(pool, KEY, true, admin.id);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(true);
    expect(await isEnabled(pool, KEY, bob.id)).toBe(true);
    expect(await isEnabled(pool, KEY, null)).toBe(true);
  });

  dbTest('a user override beats the everyone value, for that user only, in both directions', async () => {
    await setEveryoneValue(pool, KEY, true, admin.id);
    await setUserValue(pool, KEY, ann.id, false, admin.id);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
    expect(await isEnabled(pool, KEY, bob.id)).toBe(true);
    expect(await isEnabled(pool, KEY, null)).toBe(true);

    await setEveryoneValue(pool, KEY, false, admin.id);
    await setUserValue(pool, KEY, ann.id, true, admin.id);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(true);
    expect(await isEnabled(pool, KEY, bob.id)).toBe(false);
    expect(await evaluateFeatures(pool, ann.id)).toEqual({ ...DEFAULTS, [KEY]: true });
    expect(await evaluateFeatures(pool, bob.id)).toEqual(DEFAULTS);
  });

  dbTest('a user override applies with no everyone value too', async () => {
    await setUserValue(pool, KEY, ann.id, true, admin.id);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(true);
    expect(await isEnabled(pool, KEY, bob.id)).toBe(false);
  });

  dbTest('no cache: a change is seen by the very next check', async () => {
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
    await setEveryoneValue(pool, KEY, true, admin.id);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(true);
    await pool.query('delete from public.feature_overrides where feature_key = $1', [KEY]);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
  });

  dbTest('one value for everyone and one per user: setting again updates the row', async () => {
    await setEveryoneValue(pool, KEY, true, admin.id);
    await setEveryoneValue(pool, KEY, false, ann.id);
    await setUserValue(pool, KEY, bob.id, true, admin.id);
    await setUserValue(pool, KEY, bob.id, false, ann.id);
    const { rows } = await pool.query('select user_id, value, changed_by from public.feature_overrides where feature_key = $1 order by user_id nulls first', [KEY]);
    expect(rows).toEqual([
      { user_id: null, value: false, changed_by: ann.id },
      { user_id: bob.id, value: false, changed_by: ann.id },
    ]);
  });

  dbTest('a stored key that is no longer in the list is ignored', async () => {
    await pool.query(`insert into public.feature_overrides (feature_key, user_id, value) values ($1, null, true), ($1, $2, true)`, [RETIRED, ann.id]);
    expect(await evaluateFeatures(pool, ann.id)).toEqual(DEFAULTS);
    const mine = await send('GET', '/features', ann.cookie);
    expect(mine.json).toEqual({ features: DEFAULTS });
    const list = await send('GET', '/admin/features', admin.cookie);
    expect(list.json.map((f: { key: string }) => f.key)).toEqual(FEATURES.map((f) => f.key));
    expect(JSON.stringify(list.json)).not.toContain(RETIRED);
  });

  dbTest('deleting a user removes their overrides; deleting the admin who set a value keeps it', async () => {
    await setEveryoneValue(pool, KEY, true, admin.id);
    await setUserValue(pool, KEY, ann.id, false, admin.id);
    await pool.query('delete from public.users where id = $1', [ann.id]);
    expect((await pool.query('select 1 from public.feature_overrides where user_id = $1', [ann.id])).rowCount).toBe(0);
    await pool.query('delete from public.users where id = $1', [admin.id]);
    const { rows } = await pool.query('select value, changed_by from public.feature_overrides where feature_key = $1 and user_id is null', [KEY]);
    expect(rows).toEqual([{ value: true, changed_by: null }]);
  });
});

describe('GET /features', () => {
  dbTest('a signed-in user gets their own evaluated values, never cached', async () => {
    const before = await send('GET', '/features', ann.cookie);
    expect(before.status).toBe(200);
    expect(myFeaturesSchema.parse(before.json)).toEqual({ features: DEFAULTS });
    expect(before.res.headers.get('cache-control')).toBe('no-store');

    await setEveryoneValue(pool, KEY, true, admin.id);
    await setUserValue(pool, KEY, bob.id, false, admin.id);
    expect((await send('GET', '/features', ann.cookie)).json).toEqual({ features: { ...DEFAULTS, [KEY]: true } });
    expect((await send('GET', '/features', bob.cookie)).json).toEqual({ features: DEFAULTS });
    expect((await send('GET', '/features', admin.cookie)).json).toEqual({ features: { ...DEFAULTS, [KEY]: true } });
  });

  dbTest('signed out: 401', async () => {
    expect((await send('GET', '/features')).status).toBe(401);
  });
});

describe('/admin/features', () => {
  let logs: string[] = [];
  let spy: ReturnType<typeof spyOn> | null = null;
  beforeEach(() => {
    logs = [];
    spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      logs.push(a.map(String).join(' '));
    });
  });
  afterEach(() => spy?.mockRestore());

  const everyonePath = `/admin/features/${KEY}/everyone`;
  const userPath = (id: string) => `/admin/features/${KEY}/users/${id}`;
  const adminHeaders = () => ({ ...admin.cookie, origin: ADMIN_ORIGIN });

  dbTest('list: every feature in the code list with default, no everyone value and no overrides', async () => {
    const list = await send('GET', '/admin/features', admin.cookie);
    expect(list.status).toBe(200);
    for (const row of list.json) adminFeatureSchema.parse(row);
    expect(list.json).toEqual(FEATURES.map((f) => ({ key: f.key, group: f.group, description: f.description, default: f.default, everyone: null, overrides: [] })));
    expect(list.json.find((f: { key: string }) => f.key === KEY)).toMatchObject({ group: 'Banks', default: false, everyone: null });
  });

  dbTest('set and clear the everyone value; the row stores who and when', async () => {
    const started = Date.now();
    const on = await send('PUT', everyonePath, adminHeaders(), { value: true });
    expect(on.status).toBe(200);
    expect(adminFeatureSchema.parse(on.json)).toMatchObject({
      key: KEY,
      everyone: { value: true, changed_by: { id: admin.id, email: admin.email, name: 'admin' } },
      overrides: [],
    });
    expect(Math.abs(Date.parse(on.json.everyone.changed_at) - started)).toBeLessThan(60_000);
    const stored = await pool.query('select value, changed_by, changed_at from public.feature_overrides where feature_key = $1 and user_id is null', [KEY]);
    expect(stored.rows[0]).toMatchObject({ value: true, changed_by: admin.id });
    expect(stored.rows[0].changed_at).toBeInstanceOf(Date);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(true);

    const off = await send('PUT', everyonePath, adminHeaders(), { value: false });
    expect(off.json.everyone.value).toBe(false);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
    expect((await pool.query('select 1 from public.feature_overrides where feature_key = $1', [KEY])).rowCount).toBe(1);

    const cleared = await send('DELETE', everyonePath, adminHeaders());
    expect(cleared.status).toBe(200);
    expect(cleared.json.everyone).toBeNull();
    expect((await pool.query('select 1 from public.feature_overrides where feature_key = $1', [KEY])).rowCount).toBe(0);
    // Clearing again is not an error.
    expect((await send('DELETE', everyonePath, adminHeaders())).status).toBe(200);

    const events = logs.filter((l) => l.includes('admin_feature_action')).map((l) => JSON.parse(l));
    expect(events.map((e) => e.action)).toEqual(['set_everyone', 'set_everyone', 'clear_everyone']);
    expect(events[0]).toMatchObject({ actor: admin.email, feature: KEY, value: true });
  });

  dbTest('set and clear a user override; the row stores who and when, other users inherit', async () => {
    await send('PUT', everyonePath, adminHeaders(), { value: true });
    const set = await send('PUT', userPath(ann.id), adminHeaders(), { value: false });
    expect(set.status).toBe(200);
    expect(adminFeatureSchema.parse(set.json).overrides).toEqual([
      { user_id: ann.id, value: false, changed_by: { id: admin.id, email: admin.email, name: 'admin' }, changed_at: set.json.overrides[0].changed_at },
    ]);
    expect(Number.isNaN(Date.parse(set.json.overrides[0].changed_at))).toBe(false);
    const stored = await pool.query('select value, changed_by, changed_at from public.feature_overrides where feature_key = $1 and user_id = $2', [KEY, ann.id]);
    expect(stored.rows[0]).toMatchObject({ value: false, changed_by: admin.id });
    expect((await send('GET', '/features', ann.cookie)).json.features[KEY]).toBe(false);
    expect((await send('GET', '/features', bob.cookie)).json.features[KEY]).toBe(true);

    const list = await send('GET', '/admin/features', admin.cookie);
    expect(list.json[0].everyone.value).toBe(true);
    expect(list.json[0].overrides.map((o: { user_id: string }) => o.user_id)).toEqual([ann.id]);

    const cleared = await send('DELETE', userPath(ann.id), adminHeaders());
    expect(cleared.status).toBe(200);
    expect(cleared.json.overrides).toEqual([]);
    expect(cleared.json.everyone.value).toBe(true);
    expect((await send('GET', '/features', ann.cookie)).json.features[KEY]).toBe(true);
    expect((await send('DELETE', userPath(ann.id), adminHeaders())).status).toBe(200);
  });

  dbTest('bad input: an unlisted key or a non-boolean value is 400, an unknown user is 404; nothing is stored', async () => {
    expect((await send('PUT', '/admin/features/no-such-feature/everyone', adminHeaders(), { value: true })).status).toBe(400);
    expect((await send('PUT', `/admin/features/${RETIRED}/everyone`, adminHeaders(), { value: true })).status).toBe(400);
    expect((await send('PUT', everyonePath, adminHeaders(), { value: 'on' })).status).toBe(400);
    expect((await send('PUT', everyonePath, adminHeaders(), {})).status).toBe(400);
    expect((await send('PUT', userPath('not-a-uuid'), adminHeaders(), { value: true })).status).toBe(400);
    const missing = await send('PUT', userPath(crypto.randomUUID()), adminHeaders(), { value: true });
    expect(missing.status).toBe(404);
    expect(missing.json).toMatchObject({ code: 'not_found' });
    expect((await pool.query('select 1 from public.feature_overrides')).rowCount).toBe(0);
  });

  dbTest('a non-admin gets 403 on every admin operation and changes nothing', async () => {
    const h = { ...ann.cookie, origin: ADMIN_ORIGIN };
    expect((await send('GET', '/admin/features', h)).status).toBe(403);
    expect((await send('PUT', everyonePath, h, { value: true })).status).toBe(403);
    expect((await send('DELETE', everyonePath, h)).status).toBe(403);
    expect((await send('PUT', userPath(ann.id), h, { value: true })).status).toBe(403);
    expect((await send('DELETE', userPath(ann.id), h)).status).toBe(403);
    expect((await pool.query('select 1 from public.feature_overrides')).rowCount).toBe(0);
    expect(await isEnabled(pool, KEY, ann.id)).toBe(false);
  });

  dbTest('the role is read per request: a demoted admin is refused at once', async () => {
    expect((await send('GET', '/admin/features', admin.cookie)).status).toBe(200);
    await pool.query(`update public.users set role = 'user' where id = $1`, [admin.id]);
    expect((await send('PUT', everyonePath, adminHeaders(), { value: true })).status).toBe(403);
  });

  dbTest('feature rows never block deleting a user in /admin/users: own overrides go, values they set stay', async () => {
    await send('PUT', userPath(ann.id), adminHeaders(), { value: true });
    // bob, as an admin, sets the everyone value; then he is deleted.
    await pool.query(`update public.users set role = 'admin' where id = $1`, [bob.id]);
    expect((await send('PUT', everyonePath, { ...bob.cookie, origin: ADMIN_ORIGIN }, { value: true })).status).toBe(200);
    expect((await send('DELETE', `/admin/users/${ann.id}`, adminHeaders())).status).toBe(204);
    expect((await send('DELETE', `/admin/users/${bob.id}`, adminHeaders())).status).toBe(204);
    const list = await send('GET', '/admin/features', admin.cookie);
    expect(list.json[0]).toMatchObject({ everyone: { value: true, changed_by: null }, overrides: [] });
  });

  dbTest('signed out is 401; the service token, an OAuth access token and a foreign Origin are 403', async () => {
    expect((await send('GET', '/admin/features')).status).toBe(401);
    expect((await send('GET', '/admin/features', { authorization: `Bearer ${SVC_TOKEN}` })).status).toBe(403);
    // An OAuth access token of the admin (a live grant): it may read its own features, never manage them.
    const clientId = `c_featurestest_${crypto.randomUUID().slice(0, 8)}`;
    await pool.query(`insert into public.oauth_clients (client_id, client_name, redirect_uris) values ($1, 'features test', $2)`, [clientId, ['https://cb.test']]);
    const grantId = crypto.randomUUID();
    await pool.query(
      `insert into public.oauth_grants (id, user_id, client_id, scope, resource, expires_at) values ($1, $2, $3, 'read write', $4, now() + interval '1 hour')`,
      [grantId, admin.id, clientId, `${API}/mcp`],
    );
    const oauthToken = await issueAccessToken(SECRET, { email: admin.email, scope: 'read write', clientId, grantId, audience: `${API}/mcp` }, 600);
    try {
      expect((await send('GET', '/features', { authorization: `Bearer ${oauthToken}` })).status).toBe(200);
      expect((await send('GET', '/admin/features', { authorization: `Bearer ${oauthToken}` })).status).toBe(403);
      expect((await send('PUT', everyonePath, { authorization: `Bearer ${oauthToken}` }, { value: true })).status).toBe(403);
    } finally {
      await pool.query('delete from public.oauth_clients where client_id = $1', [clientId]);
    }
    const foreign = await send('PUT', everyonePath, { ...admin.cookie, origin: 'https://evil.test' }, { value: true });
    expect(foreign.status).toBe(403);
    expect(foreign.json).toMatchObject({ code: 'origin_not_allowed' });
    expect((await pool.query('select 1 from public.feature_overrides')).rowCount).toBe(0);
  });
});
