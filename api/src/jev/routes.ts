/**
 * HTTP handlers of the Jev key screen. Only parse/authorise/shape: sealing,
 * resolution and every SQL statement live in keys.ts / store.ts, and every
 * route is mounted behind requireUser by ./router.ts.
 */
import { Hono } from 'hono';

import { jevKeyDelete, jevKeyGet, jevKeySave, jevKeyTest } from '@shared/contracts/jev';

import { JevFailure } from './call';
import { pool } from '../core/db';
import { implement } from '../core/operation';
import { requireUserId } from '../user';
import { jevFailureHttpError, jevKeyStatus, readOwnKey, saveOwnKey, verifyKey } from './keys';
import { jevRouter } from './router';
import * as store from './store';

const app = new Hono();

/** One call with made-up data; a refused or unreachable key answers for the caller. */
async function probeOrFail(key: string): Promise<void> {
  try {
    await verifyKey(key);
  } catch (err) {
    if (err instanceof JevFailure) throw jevFailureHttpError(err);
    throw err;
  }
}

export const operations = [
  implement(jevKeyGet, async (c) => jevKeyStatus(pool, requireUserId(c))),

  implement(jevKeySave, async (c, { key }) => {
    const userId = requireUserId(c);
    await probeOrFail(key);
    await saveOwnKey(pool, userId, key);
    return jevKeyStatus(pool, userId);
  }),

  implement(jevKeyTest, async (c) => {
    await probeOrFail(await readOwnKey(pool, requireUserId(c)));
    return { ok: true };
  }),

  implement(jevKeyDelete, async (c) => {
    await store.deleteJevKey(pool, requireUserId(c));
    return { ok: true };
  }),
];

jevRouter(app, operations);

export default app;
