/**
 * Jev keys: the caller's own sealed key, and the key a run uses.
 *
 * Resolution for a run: the budget OWNER's own key if saved, else the
 * installation's `JEV_API_KEY` when the `shared-jev-key` feature is on for
 * them, else not configured with a reason the page explains. Called from
 * request handlers and Temporal ACTIVITIES only (it reads features and the
 * database); never from a workflow.
 */
import {
  CREDENTIALS_KEY_MISSING,
  JEV_KEY_MISSING,
  JEV_KEY_REJECTED,
  JEV_NO_CREDITS,
  JEV_UNAVAILABLE,
} from '@shared/contracts/jev';
import type { JevKeyProblem, JevKeyStatus } from '@shared/contracts/jev';

import { JevFailure, probeJevKey, sharedJevKey } from './call';
import type { Queryable } from '../core/db';
import { openSecret, sealSecret, SecretBoxOpenError, SecretBoxUnavailable } from '../core/secret-box';
import { HttpError } from '../core/validate';
import { isEnabled } from '../features';
import * as store from './store';

export type JevKeyAccess =
  | { ok: true; key: string; source: 'own' | 'shared' }
  | { ok: false; problem: JevKeyProblem };

/** Bound into the ciphertext: a key opens only on the row it was sealed for. */
const keyContext = (userId: string): string => JSON.stringify(['jev_keys', userId]);

async function openOwnKey(row: store.StoredJevKey): Promise<string> {
  return openSecret(
    { ciphertext: row.key_ciphertext, nonce: row.key_nonce, keyVersion: row.key_version },
    keyContext(row.user_id),
  );
}

/** Which key a run of this owner's budget uses, or why there is none. */
export async function resolveJevKey(db: Queryable, ownerUserId: string): Promise<JevKeyAccess> {
  const own = await store.getJevKey(db, ownerUserId);
  if (own) {
    try {
      return { ok: true, key: await openOwnKey(own), source: 'own' };
    } catch (err) {
      if (err instanceof SecretBoxUnavailable || err instanceof SecretBoxOpenError) {
        return { ok: false, problem: 'key_unreadable' };
      }
      throw err;
    }
  }
  if (!(await isEnabled(db, 'shared-jev-key', ownerUserId))) return { ok: false, problem: 'flag_off' };
  const shared = sharedJevKey();
  if (!shared) return { ok: false, problem: 'server_key_missing' };
  return { ok: true, key: shared, source: 'shared' };
}

/** The caller's own saved key (test endpoint); 400 when none is saved. */
export async function readOwnKey(db: Queryable, userId: string): Promise<string> {
  const row = await store.getJevKey(db, userId);
  if (!row) throw new HttpError(400, 'no Jev key is saved for this user', JEV_KEY_MISSING);
  try {
    return await openOwnKey(row);
  } catch (err) {
    if (err instanceof SecretBoxUnavailable) throw credentialsKeyMissing();
    if (err instanceof SecretBoxOpenError) {
      throw new HttpError(400, 'the saved Jev key cannot be read on this server; save it again', JEV_KEY_MISSING);
    }
    throw err;
  }
}

/** Seal and store the caller's key, replacing any earlier one. */
export async function saveOwnKey(db: Queryable, userId: string, key: string): Promise<void> {
  let sealed;
  try {
    sealed = await sealSecret(key, keyContext(userId));
  } catch (err) {
    if (err instanceof SecretBoxUnavailable) throw credentialsKeyMissing();
    throw err;
  }
  await store.saveJevKey(db, userId, sealed, key.slice(-4));
}

/** Test seam: a stubbed `fetch` for the key check, so no test reaches OpenRouter. */
let probeFetch: typeof fetch | undefined;

export function setJevProbeFetch(fetchImpl: typeof fetch | null): void {
  probeFetch = fetchImpl ?? undefined;
}

/** Learn whether Jev accepts a key, before it is stored and when someone asks to test it. */
export async function verifyKey(key: string): Promise<void> {
  await probeJevKey(key, probeFetch);
}

export const credentialsKeyMissing = (): HttpError =>
  new HttpError(
    503,
    'The server has no credentials encryption key configured (CREDENTIALS_ENCRYPTION_KEY), so a Jev key cannot be stored.',
    CREDENTIALS_KEY_MISSING,
  );

/** The HTTP answer for a failed Jev call: a refused key is the caller's, the rest is ours. */
export function jevFailureHttpError(err: JevFailure): HttpError {
  // The call redacts the key from every message it throws.
  if (err.kind === 'rejected_key') {
    return new HttpError(400, 'Jev refused this key. Check it in OpenRouter and save it again.', JEV_KEY_REJECTED);
  }
  if (err.kind === 'no_credits') {
    return new HttpError(402, 'This Jev key has no credits left. Add credits in OpenRouter and try again.', JEV_NO_CREDITS);
  }
  return new HttpError(502, `Jev could not be reached: ${err.message}`, JEV_UNAVAILABLE);
}
/** The status the key screen shows: masked own key, or the shared key in use, or a reason. */
export async function jevKeyStatus(db: Queryable, userId: string): Promise<JevKeyStatus> {
  const own = await store.getJevKey(db, userId);
  const access = await resolveJevKey(db, userId);
  return {
    last_four: own?.last_four ?? null,
    saved_at: own ? new Date(own.updated_at).toISOString() : null,
    using_server_key: access.ok && access.source === 'shared',
    reason: access.ok ? null : access.problem,
  };
}

/** The HTTP answer for "this budget cannot run right now", with the page's reason. */
export function jevUnavailableError(problem: JevKeyProblem): HttpError {
  const message =
    problem === 'flag_off'
      ? 'Save your own Jev key to categorize: the shared key is not available for your account.'
      : problem === 'server_key_missing'
        ? 'Save your own Jev key to categorize: this server has no shared Jev key configured.'
        : problem === 'no_owner'
          ? 'This budget has no owner, so there is no Jev key to use.'
          : 'Your saved Jev key cannot be read on this server right now. Save it again, or try later.';
  return new HttpError(503, message, JEV_UNAVAILABLE, { reason: problem });
}
