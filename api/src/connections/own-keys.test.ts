/**
 * Own Pluggy keys (budget-lqi), end to end against Postgres with a fake
 * provider at the BankAggregator port. The fake records, for every provider
 * call, WHICH key set the aggregator was built with ('shared' or the own
 * client id) and whether the own secret it received is the one the user
 * saved, so each test can assert the connection's key set was the one used.
 *
 * One describe per acceptance criterion of the task.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';

import { pool } from '../core/db';
import { configureSecretBox } from '../core/secret-box';
import { httpOnError } from '../core/validate';
import type { IdentityUser } from '../user';
import { createConnectionsActivities } from './activities';
import { PAUSE_MESSAGES } from './errors';
import { setAggregators, type AggregatorEntry } from './registry';
import connectionsApp from './routes';
import webhookApp from './webhook';
import * as store from './store';
import type { BankAggregator, ConnectTokenInput, ProviderCredentials } from './types';

let dbReady = true;
try {
  await pool.query('select 1');
} catch {
  dbReady = false;
}

const PROVIDER = 'ownkeysprov';
/** The only pairs the fake provider accepts (its POST /auth). */
const VALID_PAIRS = new Map([
  ['own-client-1', `own-secret-1-${crypto.randomUUID()}`],
  ['own-client-2', `own-secret-2-${crypto.randomUUID()}`],
]);
const SECRET_1 = VALID_PAIRS.get('own-client-1')!;
const SECRET_2 = VALID_PAIRS.get('own-client-2')!;

type Call = { op: string; keys: string; secretOk: boolean; arg?: unknown };
const calls: Call[] = [];
let sharedConfigured = true;
let lastUpdatedAt: string | null = null;
/** Which key set an upstream item lives in ('shared' or an own client id). Unlisted items are reachable by any. */
const itemHome = new Map<string, string>();
/** Item status the provider reports, and a hook run while the item is being read (mid-sync). */
let itemStatus: 'connected' | 'unauthorized' | 'quota_exhausted' = 'connected';
let duringItemRead: (() => Promise<void>) | null = null;

function fakeAggregator(credentials?: ProviderCredentials): BankAggregator {
  const keys = credentials ? credentials.clientId : 'shared';
  const secretOk = credentials ? VALID_PAIRS.get(credentials.clientId) === credentials.clientSecret : true;
  const record = (op: string, arg?: unknown) => void calls.push({ op, keys, secretOk, arg });
  return {
    environment: 'production',
    verifyCredentials: async () => {
      record('verifyCredentials');
      return secretOk;
    },
    hasItem: async (itemId) => {
      record('hasItem', itemId);
      return !itemHome.has(itemId) || itemHome.get(itemId) === keys;
    },
    createConnectToken: async (input: ConnectTokenInput) => {
      record('createConnectToken', input);
      return { token: `token-${keys}`, clientId: credentials?.clientId ?? 'shared-client', widgetUrl: null };
    },
    listExternalAccounts: async (itemId) => {
      record('listExternalAccounts', itemId);
      // One account: an empty first listing makes register wait for the item to settle.
      return [{ externalId: `acc-${itemId}`, name: 'Fake Checking', type: 'BANK', currencyCode: 'BRL', balance: 1_000, institution: 'Fake Bank' }];
    },
    listTransactions: async () => {
      record('listTransactions');
      return { transactions: [], hasMore: false };
    },
    deleteConnection: async (itemId) => record('deleteConnection', itemId),
    fetchInstitution: async () => null,
    getItemState: async (itemId) => {
      record('getItemState', itemId);
      await duringItemRead?.();
      return { status: itemStatus, lastUpdatedAt };
    },
    mapWebhookDelivery: (payload) => {
      const p = payload as { eventId: string; event: string; itemId: string };
      return { eventId: p.eventId, event: p.event, externalItemId: p.itemId, clientUserId: null, action: 'status', status: 'unauthorized', raw: payload };
    },
    mapStatus: () => 'connected',
    verifyWebhookHeaders: () => true,
  };
}
const entry: AggregatorEntry = { configured: () => sharedConfigured, create: (credentials) => fakeAggregator(credentials) };

const users: IdentityUser[] = [];
/** A fresh user (no feature value, no key set), and an app acting as them. */
async function newUser(label: string) {
  const user = { id: crypto.randomUUID(), email: `own-keys-${label}-${crypto.randomUUID()}@ownkeys.test`, role: 'user' } as IdentityUser;
  await pool.query(`insert into public.users (id, google_sub, email, role, status) values ($1, null, $2, 'user', 'active')`, [user.id, user.email]);
  users.push(user);
  const app = new Hono();
  app.onError(httpOnError);
  app.use('*', (c, next) => {
    c.set('user' as never, user as never);
    return next();
  });
  app.route('/connections', connectionsApp);
  const call = async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/connections${path}`, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, text, json: (text ? JSON.parse(text) : null) as any };
  };
  return { user, call };
}

/** The admin's switch, as the features store writes it (null clears the user's value). */
async function setSharedKeys(userId: string, value: boolean | null): Promise<void> {
  await pool.query(`delete from public.feature_overrides where feature_key = 'shared-pluggy-key' and user_id = $1`, [userId]);
  if (value !== null) {
    await pool.query(`insert into public.feature_overrides (feature_key, user_id, value) values ('shared-pluggy-key', $1, $2)`, [userId, value]);
  }
}

const saveKeys = (call: Awaited<ReturnType<typeof newUser>>['call'], clientId: string, clientSecret: string) =>
  call('PUT', '/credentials', { provider: PROVIDER, clientId, clientSecret });
const connect = async (call: Awaited<ReturnType<typeof newUser>>['call'], itemId: string) => {
  const res = await call('POST', '/items', { provider: PROVIDER, itemId });
  expect(res.status, res.text).toBe(200);
  return res.json.connection as { id: string; key_source: string; status: string };
};
const item = (label: string) => `ownkeys-${label}-${crypto.randomUUID()}`;
const reload = async (id: string) => (await store.getConnectionById(id))!;
const callsOf = (op: string) => calls.filter((c) => c.op === op);

const acts = createConnectionsActivities(pool, async (_runId, body) => body({ log: async () => {} } as never));
const syncWork = (connectionId: string) => acts.connectionsSyncWork({ runId: crypto.randomUUID(), connectionId, mode: 'sync' });

beforeAll(() => {
  if (!dbReady) return;
  setAggregators({ [PROVIDER]: entry });
  configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
});
afterAll(async () => {
  setAggregators(null);
  configureSecretBox(null);
  if (!dbReady) return;
  const ids = users.map((u) => u.id);
  await pool.query('delete from jobs.job_runs where tenant_id = any($1::text[])', [ids]).catch(() => undefined);
  await pool.query('delete from public.users where id = any($1::uuid[])', [ids]);
});
beforeEach(() => {
  calls.length = 0;
  sharedConfigured = true;
  lastUpdatedAt = null;
  itemHome.clear();
  itemStatus = 'connected';
  duringItemRead = null;
});

describe.skipIf(!dbReady)('1. own key set: save, replace, read status, delete', () => {
  test('nothing saved → nulls; a wrong pair is refused and not stored', async () => {
    const { user, call } = await newUser('crud-wrong');
    expect((await call('GET', `/credentials?provider=${PROVIDER}`)).json).toEqual({ provider: PROVIDER, clientId: null, hasSecret: false, updatedAt: null });

    const wrong = await saveKeys(call, 'own-client-1', 'not-the-secret');
    expect(wrong.status).toBe(400);
    expect(wrong.json.code).toBe('pluggy_keys_rejected');
    // The pair was checked with the provider, through the port, with exactly the submitted pair.
    expect(callsOf('verifyCredentials')).toEqual([{ op: 'verifyCredentials', keys: 'own-client-1', secretOk: false, arg: undefined }]);
    expect(await store.getCredentials(pool, user.id, PROVIDER)).toBeNull();

    const unknownId = await saveKeys(call, 'no-such-client', SECRET_1);
    expect(unknownId.status).toBe(400);
    expect(await store.getCredentials(pool, user.id, PROVIDER)).toBeNull();
  });

  test('a valid pair is saved; the answers carry the client id and never the secret; replace and delete work', async () => {
    const { user, call } = await newUser('crud');
    const saved = await saveKeys(call, 'own-client-1', SECRET_1);
    expect(saved.status).toBe(200);
    expect(saved.json).toMatchObject({ provider: PROVIDER, clientId: 'own-client-1', hasSecret: true });
    expect(Object.keys(saved.json).sort()).toEqual(['clientId', 'hasSecret', 'provider', 'updatedAt']);
    expect(saved.text.includes(SECRET_1)).toBe(false);

    const read = await call('GET', `/credentials?provider=${PROVIDER}`);
    expect(read.json).toMatchObject({ clientId: 'own-client-1', hasSecret: true });
    expect(read.text.includes(SECRET_1)).toBe(false);

    // Replace: still one key set per user.
    const replaced = await saveKeys(call, 'own-client-2', SECRET_2);
    expect(replaced.json).toMatchObject({ clientId: 'own-client-2', hasSecret: true });
    const rows = await pool.query('select client_id from public.connection_credentials where user_id = $1', [user.id]);
    expect(rows.rows).toEqual([{ client_id: 'own-client-2' }]);

    expect((await call('DELETE', `/credentials?provider=${PROVIDER}`)).json).toEqual({ ok: true });
    expect((await call('GET', `/credentials?provider=${PROVIDER}`)).json).toMatchObject({ clientId: null, hasSecret: false });
    // Idempotent.
    expect((await call('DELETE', `/credentials?provider=${PROVIDER}`)).status).toBe(200);
  });

  test('unknown provider → 404; input is validated', async () => {
    const { call } = await newUser('crud-input');
    expect((await call('GET', '/credentials?provider=nope')).status).toBe(404);
    expect((await call('PUT', '/credentials', { provider: 'nope', clientId: 'a', clientSecret: 'b' })).status).toBe(404);
    expect((await call('PUT', '/credentials', { provider: PROVIDER, clientId: '', clientSecret: 'b' })).status).toBe(400);
    expect((await call('PUT', '/credentials', { provider: PROVIDER, clientId: 'a' })).status).toBe(400);
    expect(callsOf('verifyCredentials')).toEqual([]);
  });

  test('a provider outage while checking the pair is a 502, nothing stored', async () => {
    const { user, call } = await newUser('crud-outage');
    setAggregators({
      [PROVIDER]: {
        configured: () => true,
        create: (credentials) => ({ ...fakeAggregator(credentials), verifyCredentials: async () => Promise.reject(new Error('Pluggy API 503: down')) }),
      },
    });
    try {
      const res = await saveKeys(call, 'own-client-1', SECRET_1);
      expect(res.status).toBe(502);
      expect(res.text.includes(SECRET_1)).toBe(false);
      expect(await store.getCredentials(pool, user.id, PROVIDER)).toBeNull();
    } finally {
      setAggregators({ [PROVIDER]: entry });
    }
  });
});

describe.skipIf(!dbReady)('2. the secret is stored encrypted with the master key', () => {
  test('no table holds the plaintext secret in any encoding; nonce and ciphertext are per value', async () => {
    const { user, call } = await newUser('dump');
    expect((await saveKeys(call, 'own-client-1', SECRET_1)).status).toBe(200);
    const first = (await store.getCredentials(pool, user.id, PROVIDER))!;
    expect(first.key_version).toBe(1);
    expect(first.secret_nonce.length).toBe(12);
    expect(first.secret_ciphertext.includes(Buffer.from(SECRET_1))).toBe(false);

    // What a dump would contain: every row of every table, as text. bytea prints as hex.
    const needles = [SECRET_1, Buffer.from(SECRET_1).toString('hex'), Buffer.from(SECRET_1).toString('base64')];
    const tables = await pool.query<{ table_schema: string; table_name: string }>(
      `select table_schema, table_name from information_schema.tables
        where table_type = 'BASE TABLE' and table_schema in ('public', 'jobs')`,
    );
    expect(tables.rows.some((t) => t.table_name === 'connection_credentials')).toBe(true);
    const leaks: string[] = [];
    for (const t of tables.rows) {
      const hit = await pool.query(
        `select 1 from "${t.table_schema}"."${t.table_name}" x where strpos(x::text, $1) > 0 or strpos(x::text, $2) > 0 or strpos(x::text, $3) > 0 limit 1`,
        needles,
      );
      if ((hit.rowCount ?? 0) > 0) leaks.push(`${t.table_schema}.${t.table_name}`);
    }
    expect(leaks).toEqual([]);
    // The scan does see what IS stored in the clear (the client id), so it is not vacuous.
    const seen = await pool.query(`select 1 from public.connection_credentials x where strpos(x::text, 'own-client-1') > 0 and user_id = $1`, [user.id]);
    expect(seen.rowCount).toBe(1);

    // Saving the same secret again gives a fresh nonce and a different ciphertext.
    expect((await saveKeys(call, 'own-client-1', SECRET_1)).status).toBe(200);
    const second = (await store.getCredentials(pool, user.id, PROVIDER))!;
    expect(second.secret_nonce.equals(first.secret_nonce)).toBe(false);
    expect(second.secret_ciphertext.equals(first.secret_ciphertext)).toBe(false);
  });

  test("another user's ciphertext does not decrypt on my row (bound to user and provider)", async () => {
    const a = await newUser('swap-a');
    const b = await newUser('swap-b');
    await saveKeys(a.call, 'own-client-1', SECRET_1);
    await saveKeys(b.call, 'own-client-1', SECRET_1);
    await pool.query(
      `update public.connection_credentials k set secret_ciphertext = o.secret_ciphertext, secret_nonce = o.secret_nonce
         from public.connection_credentials o where k.user_id = $1 and o.user_id = $2`,
      [b.user.id, a.user.id],
    );
    const res = await b.call('POST', '/connect-token', { provider: PROVIDER });
    expect(res.status).toBe(503);
    expect(res.json.code).toBe('credentials_key_missing');
    expect(callsOf('createConnectToken')).toEqual([]);
  });

  test('no master key: saving answers 503 credentials_key_missing and stores nothing; reading still works', async () => {
    const { user, call } = await newUser('nokey');
    configureSecretBox(null);
    try {
      const res = await saveKeys(call, 'own-client-1', SECRET_1);
      expect(res.status).toBe(503);
      expect(res.json.code).toBe('credentials_key_missing');
      expect(callsOf('verifyCredentials')).toEqual([]);
      expect(await store.getCredentials(pool, user.id, PROVIDER)).toBeNull();
      expect((await call('GET', `/credentials?provider=${PROVIDER}`)).status).toBe(200);
    } finally {
      configureSecretBox({ current: 1, keys: new Map([[1, crypto.getRandomValues(new Uint8Array(32))]]) });
    }
  });
});

describe.skipIf(!dbReady)('3. every connection records the key set that created it', () => {
  test('shared keys → key_source shared; own keys → key_source own + the client id; a row inserted the old way is shared', async () => {
    const { user, call } = await newUser('record');
    await setSharedKeys(user.id, true);
    const shared = await connect(call, item('shared'));
    expect(shared.key_source).toBe('shared');
    expect(await reload(shared.id)).toMatchObject({ key_source: 'shared', key_client_id: null });

    await saveKeys(call, 'own-client-1', SECRET_1);
    const own = await connect(call, item('own'));
    expect(own.key_source).toBe('own');
    expect(await reload(own.id)).toMatchObject({ key_source: 'own', key_client_id: 'own-client-1' });

    // What syscd-app (and every row from before 0104) looks like: no key columns named.
    const legacyId = crypto.randomUUID();
    await pool.query(`insert into public.connections (id, user_id, provider, external_id, status) values ($1, $2, $3, $4, 'connected')`, [
      legacyId, user.id, PROVIDER, item('legacy'),
    ]);
    expect(await reload(legacyId)).toMatchObject({ key_source: 'shared', key_client_id: null });

    // Registering a known item again keeps what the row recorded.
    const again = await connect(call, (await reload(shared.id)).external_id);
    expect(again).toMatchObject({ id: shared.id, key_source: 'shared' });
    const listed = (await call('GET', '')).json as Array<{ id: string; key_source: string }>;
    expect(Object.fromEntries(listed.map((r) => [r.id, r.key_source]))).toMatchObject({ [shared.id]: 'shared', [own.id]: 'own', [legacyId]: 'shared' });
  });
});

describe.skipIf(!dbReady)("4. every call uses the connection's key set; own keys win for a new connection", () => {
  test('connect-token, register, upstream, delete, sync activity and sweep', async () => {
    const { user, call } = await newUser('uses');
    await setSharedKeys(user.id, true);
    const sharedItem = item('shared');
    const shared = await connect(call, sharedItem);
    expect(callsOf('listExternalAccounts').at(-1)).toMatchObject({ keys: 'shared', arg: sharedItem });

    // The user now has BOTH: the feature and an own key set.
    await saveKeys(call, 'own-client-1', SECRET_1);
    calls.length = 0;

    // New connection: own keys win.
    const token = await call('POST', '/connect-token', { provider: PROVIDER });
    expect(token.json).toMatchObject({ token: 'token-own-client-1', clientId: 'own-client-1' });
    const ownItem = item('own');
    const own = await connect(call, ownItem);
    expect(own.key_source).toBe('own');
    expect(callsOf('listExternalAccounts').at(-1)).toMatchObject({ keys: 'own-client-1', secretOk: true, arg: ownItem });

    // Re-auth of the shared-key connection stays on the shared keys.
    const reauth = await call('POST', '/connect-token', { provider: PROVIDER, itemId: sharedItem });
    expect(reauth.json).toMatchObject({ token: 'token-shared', clientId: 'shared-client' });
    const reauthOwn = await call('POST', '/connect-token', { provider: PROVIDER, itemId: ownItem });
    expect(reauthOwn.json).toMatchObject({ token: 'token-own-client-1' });

    // Upstream: each connection listed with its own key set.
    calls.length = 0;
    expect((await call('GET', '/upstream')).status).toBe(200);
    expect(Object.fromEntries(callsOf('listExternalAccounts').map((c) => [c.arg, c.keys]))).toEqual({ [sharedItem]: 'shared', [ownItem]: 'own-client-1' });
    expect(calls.every((c) => c.secretOk)).toBe(true);

    // Sync activity.
    calls.length = 0;
    await syncWork(shared.id);
    expect(callsOf('getItemState')).toEqual([{ op: 'getItemState', keys: 'shared', secretOk: true, arg: sharedItem }]);
    calls.length = 0;
    await syncWork(own.id);
    expect(callsOf('getItemState')).toEqual([{ op: 'getItemState', keys: 'own-client-1', secretOk: true, arg: ownItem }]);

    // Sweep: both are listed and each is checked with its key set.
    const swept = (await acts.connectionsSweepList()).map((r) => r.id);
    expect(swept).toEqual(expect.arrayContaining([shared.id, own.id]));
    calls.length = 0;
    lastUpdatedAt = '2000-01-01T00:00:00Z';
    expect(await acts.connectionsSweepCheck({ connectionId: shared.id })).toBe('fresh');
    expect(await acts.connectionsSweepCheck({ connectionId: own.id })).toBe('fresh');
    expect(callsOf('getItemState').map((c) => c.keys)).toEqual(['shared', 'own-client-1']);

    // Manual sync is accepted for both.
    expect((await call('POST', `/${shared.id}/sync`)).status).toBe(200);
    expect((await call('POST', `/${own.id}/sync`)).status).toBe(200);

    // Delete: each removed upstream with its key set.
    calls.length = 0;
    expect((await call('DELETE', `/${shared.id}`)).status).toBe(200);
    expect((await call('DELETE', `/${own.id}`)).status).toBe(200);
    expect(callsOf('deleteConnection').map((c) => [c.arg, c.keys, c.secretOk])).toEqual([[sharedItem, 'shared', true], [ownItem, 'own-client-1', true]]);
  });

  test('own keys work when the installation has no shared keys at all', async () => {
    sharedConfigured = false;
    const { call } = await newUser('no-shared-env');
    await saveKeys(call, 'own-client-2', SECRET_2);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-own-client-2' });
    const own = await connect(call, item('own'));
    expect(own.key_source).toBe('own');
    await syncWork(own.id);
    expect((await reload(own.id)).status).toBe('connected');
  });
});

describe.skipIf(!dbReady)('5. the shared keys need the feature', () => {
  test('no own keys and no feature → 403 own_keys_required, the provider is never called', async () => {
    const { user, call } = await newUser('gate');
    for (const [path, body] of [['/connect-token', { provider: PROVIDER }], ['/items', { provider: PROVIDER, itemId: item('x') }]] as const) {
      const res = await call('POST', path, body);
      expect(res.status, path).toBe(403);
      expect(res.json.code, path).toBe('own_keys_required');
      expect(res.json.error).toContain('own Pluggy keys');
    }
    expect(calls).toEqual([]);
    expect((await pool.query('select 1 from public.connections where user_id = $1', [user.id])).rowCount).toBe(0);

    // An explicit "off" for this user beats an "on" for everyone.
    await setSharedKeys(user.id, false);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json.code).toBe('own_keys_required');

    // Feature on → the shared keys are used.
    await setSharedKeys(user.id, true);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-shared' });
    // Feature on but the installation has no shared keys → the old 503.
    sharedConfigured = false;
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).status).toBe(503);
  });

  test('without the feature a user with own keys connects on their own keys', async () => {
    const { call } = await newUser('gate-own');
    await saveKeys(call, 'own-client-1', SECRET_1);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-own-client-1' });
  });
});

describe.skipIf(!dbReady)('6. feature off pauses shared-key connections; on resumes them', () => {
  test('the sweep and the sync activity pause without any endpoint being called, and resume', async () => {
    const { user, call } = await newUser('pause-worker');
    await setSharedKeys(user.id, true);
    const shared = await connect(call, item('shared'));
    await saveKeys(call, 'own-client-1', SECRET_1);
    const own = await connect(call, item('own'));
    await syncWork(shared.id);
    expect((await reload(shared.id)).status).toBe('connected');

    // The admin turns the feature off. No endpoint is called from here on.
    await setSharedKeys(user.id, false);
    calls.length = 0;

    // Sync activity (e.g. a webhook-triggered run): skipped, provider untouched, row paused.
    expect(await syncWork(shared.id)).toEqual({ skipped: 'paused' });
    expect(calls).toEqual([]);
    expect(await reload(shared.id)).toMatchObject({ status: 'paused', status_message: PAUSE_MESSAGES.shared, next_poll_at: null });

    // Sweep: skipped too, and it does not even read the item.
    expect(await acts.connectionsSweepCheck({ connectionId: shared.id })).toBe('skipped');
    expect(calls).toEqual([]);

    // The own-key connection of the same user is not affected.
    expect(await acts.connectionsSweepCheck({ connectionId: own.id })).toBe('enqueued');
    expect((await reload(own.id)).status).toBe('connected');
    expect(callsOf('getItemState').map((c) => c.keys)).toEqual(['own-client-1']);

    // Paused rows stay in the sweep's list, so the sweep is what resumes them.
    expect((await acts.connectionsSweepList()).map((r) => r.id)).toContain(shared.id);

    // The admin turns it on again: the next sweep resumes and syncs, whatever the watermark says.
    await setSharedKeys(user.id, true);
    calls.length = 0;
    lastUpdatedAt = '2000-01-01T00:00:00Z';
    expect(await acts.connectionsSweepCheck({ connectionId: shared.id })).toBe('enqueued');
    expect(await reload(shared.id)).toMatchObject({ status: 'connected', status_message: null });
    expect(callsOf('getItemState').map((c) => c.keys)).toEqual(['shared']);
    expect(await syncWork(shared.id)).toMatchObject({ added: 0 });
  });

  test('pausing straight from the sweep (no sync in between)', async () => {
    const { user, call } = await newUser('pause-sweep');
    await setSharedKeys(user.id, true);
    const shared = await connect(call, item('shared'));
    await setSharedKeys(user.id, null); // cleared: back to the default, which is off
    calls.length = 0;
    expect(await acts.connectionsSweepCheck({ connectionId: shared.id })).toBe('skipped');
    expect(calls).toEqual([]);
    expect((await reload(shared.id)).status).toBe('paused');
  });

  test('the endpoints show and enforce the pause, and never delete the connection', async () => {
    const { user, call } = await newUser('pause-api');
    await setSharedKeys(user.id, true);
    const sharedItem = item('shared');
    const shared = await connect(call, sharedItem);
    await setSharedKeys(user.id, false);
    calls.length = 0;

    const listed = (await call('GET', '')).json as Array<{ id: string; status: string; status_message: string | null }>;
    expect(listed).toEqual([expect.objectContaining({ id: shared.id, status: 'paused', status_message: PAUSE_MESSAGES.shared })]);
    expect((await call('GET', `/${shared.id}`)).json).toMatchObject({ status: 'paused' });

    // Upstream: the row is there, with no accounts, and the provider was not called.
    const upstream = (await call('GET', '/upstream')).json as Array<{ connection: { id: string; status: string }; accounts: unknown }>;
    expect(upstream).toEqual([{ connection: expect.objectContaining({ id: shared.id, status: 'paused' }), accounts: null }]);

    const status = (await call('GET', '/sync-status')).json as { connections: Array<{ id: string; state: string; status: string }> };
    expect(status.connections).toEqual([expect.objectContaining({ id: shared.id, state: 'paused', status: 'paused' })]);
    // The stored English sentence is unchanged; its code rides next to it.
    expect(listed[0]).toMatchObject({ status_message: PAUSE_MESSAGES.shared, status_message_code: 'server_paused_shared_keys' });
    expect(status.connections[0]).toMatchObject({ status_message: PAUSE_MESSAGES.shared, status_message_code: 'server_paused_shared_keys' });

    const sync = await call('POST', `/${shared.id}/sync`);
    expect(sync.status).toBe(409);
    expect(sync.json).toEqual({ error: PAUSE_MESSAGES.shared, code: 'connection_paused' });
    expect((await call('POST', `/${shared.id}/reimport`)).status).toBe(409);

    // Re-auth and a new connection both need a usable key set.
    expect((await call('POST', '/connect-token', { provider: PROVIDER, itemId: sharedItem })).json.code).toBe('own_keys_required');
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json.code).toBe('own_keys_required');
    expect((await call('POST', '/items', { provider: PROVIDER, itemId: sharedItem })).json.code).toBe('own_keys_required');
    expect(calls).toEqual([]);

    // Adding own keys does not move the item: it stays paused on the shared key set.
    await saveKeys(call, 'own-client-1', SECRET_1);
    expect((await call('GET', `/${shared.id}`)).json).toMatchObject({ status: 'paused', key_source: 'shared' });
    expect((await pool.query('select 1 from public.connections where id = $1', [shared.id])).rowCount).toBe(1);

    // Turned on again: resumed on the next read.
    await setSharedKeys(user.id, true);
    expect((await call('GET', `/${shared.id}`)).json).toMatchObject({ status: 'connected', status_message: null });
    expect((await call('POST', `/${shared.id}/sync`)).status).toBe(200);
  });

  test('a paused shared-key connection can still be removed (upstream too)', async () => {
    const { user, call } = await newUser('pause-delete');
    await setSharedKeys(user.id, true);
    const sharedItem = item('shared');
    const shared = await connect(call, sharedItem);
    await setSharedKeys(user.id, false);
    calls.length = 0;
    expect((await call('DELETE', `/${shared.id}`)).status).toBe(200);
    expect(callsOf('deleteConnection')).toEqual([{ op: 'deleteConnection', keys: 'shared', secretOk: true, arg: sharedItem }]);
    expect((await reload(shared.id)).status).toBe('disconnected');
    // Disconnected is final: turning the feature on does not bring it back.
    await setSharedKeys(user.id, true);
    expect((await call('GET', `/${shared.id}`)).json).toMatchObject({ status: 'disconnected' });
  });

  test('own-key connections pause when their key set is removed or replaced, and resume when it is back', async () => {
    const { user, call } = await newUser('pause-own');
    await saveKeys(call, 'own-client-1', SECRET_1);
    const ownItem = item('own');
    const own = await connect(call, ownItem);

    await call('DELETE', `/credentials?provider=${PROVIDER}`);
    expect(await reload(own.id)).toMatchObject({ status: 'paused', status_message: PAUSE_MESSAGES.own });
    calls.length = 0;
    expect(await syncWork(own.id)).toEqual({ skipped: 'paused' });
    expect(calls).toEqual([]);
    // The shared-keys feature does not rescue it: the item belongs to the own application.
    await setSharedKeys(user.id, true);
    expect((await call('GET', `/${own.id}`)).json).toMatchObject({ status: 'paused' });

    // A different application's keys do not resume it either.
    await saveKeys(call, 'own-client-2', SECRET_2);
    expect((await reload(own.id)).status).toBe('paused');

    // The original key set again: resumed.
    await saveKeys(call, 'own-client-1', SECRET_1);
    expect(await reload(own.id)).toMatchObject({ status: 'connected', status_message: null });
    calls.length = 0;
    await syncWork(own.id);
    expect(callsOf('getItemState')).toEqual([{ op: 'getItemState', keys: 'own-client-1', secretOk: true, arg: ownItem }]);

    // Keys gone: it can still be disconnected locally (nothing here can reach the item).
    await call('DELETE', `/credentials?provider=${PROVIDER}`);
    calls.length = 0;
    expect((await call('DELETE', `/${own.id}`)).status).toBe(200);
    expect(callsOf('deleteConnection')).toEqual([]);
    expect((await reload(own.id)).status).toBe('disconnected');
  });
});

describe.skipIf(!dbReady)('7. own-key connections pass no webhookUrl', () => {
  test('connect-token sends no webhookUrl for own keys (new and re-auth), and none for shared, as before', async () => {
    const { user, call } = await newUser('webhook');
    await saveKeys(call, 'own-client-1', SECRET_1);
    const ownItem = item('own');
    await connect(call, ownItem);
    calls.length = 0;
    await call('POST', '/connect-token', { provider: PROVIDER, connectorId: 200 });
    await call('POST', '/connect-token', { provider: PROVIDER, itemId: ownItem });
    const own = callsOf('createConnectToken');
    expect(own.map((c) => c.keys)).toEqual(['own-client-1', 'own-client-1']);
    for (const c of own) {
      expect(c.arg).toMatchObject({ clientUserId: user.id });
      expect(Object.keys(c.arg as object)).not.toContain('webhookUrl');
      expect(JSON.stringify(c.arg)).not.toContain('webhook');
    }

    const other = await newUser('webhook-shared');
    await setSharedKeys(other.user.id, true);
    calls.length = 0;
    await other.call('POST', '/connect-token', { provider: PROVIDER });
    expect(callsOf('createConnectToken')).toEqual([expect.objectContaining({ keys: 'shared' })]);
    expect(Object.keys(callsOf('createConnectToken')[0]!.arg as object)).not.toContain('webhookUrl');
  });
});

describe.skipIf(!dbReady)('8. migration 0104', () => {
  const sql = readFileSync(join(import.meta.dir, '..', '..', 'db', 'migrations', '0104_own_pluggy_keys.sql'), 'utf8');

  test('turns the feature on for every user who already has a connection, and only for them', async () => {
    const withConnection = await newUser('mig-has');
    const twoConnections = await newUser('mig-two');
    const disconnected = await newUser('mig-disc');
    const none = await newUser('mig-none');
    const alreadyOff = await newUser('mig-off');
    const insert = (userId: string, status = 'connected') =>
      pool.query(`insert into public.connections (id, user_id, provider, external_id, status) values (gen_random_uuid(), $1, 'pluggy', $2, $3)`, [
        userId, item('mig'), status,
      ]);
    await insert(withConnection.user.id);
    await insert(twoConnections.user.id);
    await insert(twoConnections.user.id, 'error');
    await insert(disconnected.user.id, 'disconnected');
    await insert(alreadyOff.user.id);
    await setSharedKeys(alreadyOff.user.id, false); // an admin's choice must survive a re-run

    // The file is idempotent (if not exists / on conflict), so running it again here is the migration.
    await pool.query(sql);
    await pool.query(sql);

    const value = async (userId: string) =>
      (await pool.query<{ value: boolean }>(`select value from public.feature_overrides where feature_key = 'shared-pluggy-key' and user_id = $1`, [userId])).rows.map((r) => r.value);
    expect(await value(withConnection.user.id)).toEqual([true]);
    expect(await value(twoConnections.user.id)).toEqual([true]);
    expect(await value(disconnected.user.id)).toEqual([true]);
    expect(await value(none.user.id)).toEqual([]);
    expect(await value(alreadyOff.user.id)).toEqual([false]);

    // And those rows are what the API reads: the user keeps syncing on the shared keys.
    expect((await withConnection.call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-shared' });
    expect((await none.call('POST', '/connect-token', { provider: PROVIDER })).json.code).toBe('own_keys_required');
  });

  test('existing rows are backfilled as shared and key_source accepts only shared or own', async () => {
    const { user } = await newUser('mig-backfill');
    const id = crypto.randomUUID();
    await pool.query(`insert into public.connections (id, user_id, provider, external_id, status) values ($1, $2, 'pluggy', $3, 'connected')`, [id, user.id, item('bf')]);
    expect(await reload(id)).toMatchObject({ key_source: 'shared', key_client_id: null });
    const column = await pool.query<{ is_nullable: string; column_default: string }>(
      `select is_nullable, column_default from information_schema.columns where table_schema = 'public' and table_name = 'connections' and column_name = 'key_source'`,
    );
    expect(column.rows[0]).toMatchObject({ is_nullable: 'NO' });
    expect(column.rows[0]!.column_default).toContain('shared');
    await expect(pool.query(`update public.connections set key_source = 'other' where id = $1`, [id])).rejects.toThrow(/connections_key_source_check/);
    expect((await pool.query(`select count(*)::int as n from public.connections where key_source is null`)).rows[0].n).toBe(0);
  });
});

describe.skipIf(!dbReady)('review fixes', () => {
  test('1. the sweep retries an own-key connection in error; a shared-key one in error still waits', async () => {
    const { user, call } = await newUser('sweep-error');
    await setSharedKeys(user.id, true);
    const shared = await connect(call, item('shared'));
    itemHome.clear();
    await saveKeys(call, 'own-client-1', SECRET_1);
    const own = await connect(call, item('own'));
    expect(own.key_source).toBe('own');
    await store.setConnectionStatus(shared.id, 'error', 'boom');
    await store.setConnectionStatus(own.id, 'error', 'boom');

    const listed = (await acts.connectionsSweepList()).map((r) => r.id);
    expect(listed).toContain(own.id);
    expect(listed).not.toContain(shared.id);

    calls.length = 0;
    lastUpdatedAt = '2000-01-01T00:00:00Z'; // nothing new upstream: an error row is retried anyway
    expect(await acts.connectionsSweepCheck({ connectionId: own.id })).toBe('enqueued');
    expect(await acts.connectionsSweepCheck({ connectionId: shared.id })).toBe('skipped');
    expect(callsOf('getItemState').map((c) => c.keys)).toEqual(['own-client-1']);
    // The enqueued sync clears the error.
    await syncWork(own.id);
    expect(await reload(own.id)).toMatchObject({ status: 'connected', status_message: null });
    expect((await reload(shared.id)).status).toBe('error');
  });

  test('2a. register: a shared-key item stays shared although own keys were saved after the token was issued', async () => {
    const { user, call } = await newUser('probe-shared');
    await setSharedKeys(user.id, true);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-shared' });
    const itemId = item('made-with-shared');
    itemHome.set(itemId, 'shared');
    // Another tab: own keys saved while the widget is open. Own would now win for a NEW choice.
    await saveKeys(call, 'own-client-1', SECRET_1);
    calls.length = 0;
    const row = await connect(call, itemId);
    expect(row.key_source).toBe('shared');
    expect(await reload(row.id)).toMatchObject({ key_source: 'shared', key_client_id: null });
    expect(callsOf('hasItem').map((c) => c.keys)).toEqual(['own-client-1', 'shared']);
    // Everything after the probe ran on the key set that holds the item.
    expect(callsOf('listExternalAccounts').map((c) => c.keys)).toEqual(['shared']);
  });

  test('2b. register: an own-key item is recorded as own; when its keys are gone mid-flow nothing is stored', async () => {
    const { user, call } = await newUser('probe-own');
    await setSharedKeys(user.id, true);
    await saveKeys(call, 'own-client-1', SECRET_1);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json).toMatchObject({ token: 'token-own-client-1' });
    const kept = item('made-with-own');
    itemHome.set(kept, 'own-client-1');
    expect(await reload((await connect(call, kept)).id)).toMatchObject({ key_source: 'own', key_client_id: 'own-client-1' });

    // Second item created with the own keys, which are then deleted (or replaced) before register.
    const lost = item('made-with-own-then-deleted');
    itemHome.set(lost, 'own-client-1');
    for (const change of [() => call('DELETE', `/credentials?provider=${PROVIDER}`), () => saveKeys(call, 'own-client-2', SECRET_2)]) {
      await change();
      calls.length = 0;
      const res = await call('POST', '/items', { provider: PROVIDER, itemId: lost });
      expect(res.status).toBe(409);
      expect(res.json.code).toBe('item_not_reachable');
      expect(callsOf('listExternalAccounts')).toEqual([]);
      expect((await pool.query('select 1 from public.connections where external_id = $1', [lost])).rowCount).toBe(0);
    }
    // The client cannot name a key set: an extra field is ignored and the probe still decides.
    const forced = await call('POST', '/items', { provider: PROVIDER, itemId: lost, keySource: 'shared', key_source: 'shared' });
    expect(forced.status).toBe(409);

    // A provider outage during the probe is a 502, nothing stored.
    const outage = item('outage');
    setAggregators({ [PROVIDER]: { configured: () => true, create: (c) => ({ ...fakeAggregator(c), hasItem: async () => Promise.reject(new Error('Pluggy API 503: down')) }) } });
    try {
      expect((await call('POST', '/items', { provider: PROVIDER, itemId: outage })).status).toBe(502);
    } finally {
      setAggregators({ [PROVIDER]: entry });
    }
    expect((await pool.query('select 1 from public.connections where external_id = $1', [outage])).rowCount).toBe(0);
  });

  test("3. connect-token with another user's itemId is a 404 and the item id never goes upstream", async () => {
    const owner = await newUser('foreign-owner');
    await setSharedKeys(owner.user.id, true);
    const itemId = item('theirs');
    await connect(owner.call, itemId);
    const other = await newUser('foreign-other');
    await setSharedKeys(other.user.id, true);
    calls.length = 0;
    const res = await other.call('POST', '/connect-token', { provider: PROVIDER, itemId });
    expect(res.status).toBe(404);
    expect(calls).toEqual([]);
    // Without the item id they still get a token for a new connection.
    expect((await other.call('POST', '/connect-token', { provider: PROVIDER })).status).toBe(200);
  });

  test('4. a paused connection is not un-paused by a webhook status event or by a sync that finishes after the pause', async () => {
    const { user, call } = await newUser('paused-guard');
    await setSharedKeys(user.id, true);
    const itemId = item('shared');
    const shared = await connect(call, itemId);

    // A sync is running (item read in flight) when the admin turns the feature off and the pause lands.
    duringItemRead = async () => {
      duringItemRead = null;
      await setSharedKeys(user.id, false);
      await call('GET', '');
      expect((await reload(shared.id)).status).toBe('paused');
    };
    await syncWork(shared.id);
    expect(await reload(shared.id)).toMatchObject({ status: 'paused', status_message: PAUSE_MESSAGES.shared });

    // Webhook item/error (maps to status 'unauthorized' in this fake).
    const hook = new Hono();
    hook.onError(httpOnError);
    hook.route('/connections', webhookApp);
    const res = await hook.request(`/connections/webhook/${PROVIDER}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ eventId: crypto.randomUUID(), event: 'item/error', itemId }),
    });
    expect(res.status).toBe(200);
    expect(await reload(shared.id)).toMatchObject({ status: 'paused', status_message: PAUSE_MESSAGES.shared });

    // Every generic writer is refused; a not-paused row still takes the same write.
    await store.setConnectionStatus(shared.id, 'connected', null);
    await store.setConnectionStatus(shared.id, 'error', 'x');
    expect((await reload(shared.id)).status).toBe('paused');
    await acts.connectionsMarkFailed({ connectionId: shared.id, failureType: 'Transient' });
    expect((await reload(shared.id)).status).toBe('paused');

    // Only the reconcile path resumes it.
    await setSharedKeys(user.id, true);
    await call('GET', '');
    expect((await reload(shared.id)).status).toBe('connected');
    await pool.query(`delete from public.connection_events where external_item_id = $1`, [itemId]);
  });

  test('5. resume restores the status the row had when it was paused (unauthorized, quota with its pause-until)', async () => {
    const { user, call } = await newUser('restore');
    await setSharedKeys(user.id, true);
    const reauth = await connect(call, item('reauth'));
    const quota = await connect(call, item('quota'));
    const healthy = await connect(call, item('healthy'));
    const until = new Date(Date.now() + 5 * 24 * 3600 * 1000);
    await store.setConnectionStatus(reauth.id, 'unauthorized', 'Reconnect your bank');
    await store.setConnectionStatus(quota.id, 'quota_exhausted', 'Bank limits reached', until);

    await setSharedKeys(user.id, false);
    await call('GET', '');
    for (const c of [reauth, quota, healthy]) {
      expect(await reload(c.id)).toMatchObject({ status: 'paused', status_message: PAUSE_MESSAGES.shared, next_poll_at: null });
    }

    await setSharedKeys(user.id, true);
    // Resumed by the sweep: the restored states decide what it does next.
    calls.length = 0;
    expect(await acts.connectionsSweepCheck({ connectionId: reauth.id })).toBe('skipped');
    expect(await acts.connectionsSweepCheck({ connectionId: quota.id })).toBe('skipped');
    expect(calls).toEqual([]);
    expect(await reload(reauth.id)).toMatchObject({ status: 'unauthorized', status_message: 'Reconnect your bank', next_poll_at: null });
    const restored = await reload(quota.id);
    expect(restored).toMatchObject({ status: 'quota_exhausted', status_message: 'Bank limits reached' });
    expect(restored.next_poll_at?.getTime()).toBe(until.getTime());
    expect(await reload(healthy.id)).toMatchObject({ status: 'connected', status_message: null });
    const left = await pool.query(`select count(*)::int as n from public.connections where user_id = $1 and paused_from is not null`, [user.id]);
    expect(left.rows[0].n).toBe(0);
    // The quota-paused one is not swept before its date.
    expect((await acts.connectionsSweepList()).map((r) => r.id)).not.toContain(quota.id);
  });

  test('6. the ciphertext is bound to the client id and the key version of its row', async () => {
    const { user, call } = await newUser('aad');
    await saveKeys(call, 'own-client-1', SECRET_1);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).status).toBe(200);

    // Same user, same provider, same bytes, another client id on the row: does not open.
    await pool.query(`update public.connection_credentials set client_id = 'own-client-2' where user_id = $1`, [user.id]);
    calls.length = 0;
    const swapped = await call('POST', '/connect-token', { provider: PROVIDER });
    expect(swapped.status).toBe(503);
    expect(swapped.json.code).toBe('credentials_key_missing');
    expect(calls).toEqual([]);

    // Client id back, key version relabelled to another configured key: does not open either.
    await pool.query(`update public.connection_credentials set client_id = 'own-client-1' where user_id = $1`, [user.id]);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).status).toBe(200);
    await pool.query(`update public.connection_credentials set key_version = 99 where user_id = $1`, [user.id]);
    expect((await call('POST', '/connect-token', { provider: PROVIDER })).json.code).toBe('credentials_key_missing');
  });
});
