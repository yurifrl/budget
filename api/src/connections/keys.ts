/**
 * Key sets: which provider credentials a connection runs on, and whether its
 * owner may use them right now. Called from request handlers and Temporal
 * ACTIVITIES only (it reads features and the database); never from
 * workflows.ts.
 *
 * Rules (owner's decisions, budget-lqi):
 *  - Every connection records the key set that created its upstream item
 *    (`connections.key_source`): 'shared' = the installation's keys, 'own' =
 *    the owner's own key set (`key_client_id` says which client id). An item
 *    is reachable only with the credentials that created it, so an existing
 *    connection always uses the key set it recorded.
 *  - A NEW connection uses the caller's own key set when one is saved (own
 *    wins), else the shared keys when feature 'shared-pluggy-key' is on for
 *    the caller, else nothing: `own_keys_required`.
 *  - A connection whose key set may not be used is PAUSED, never deleted:
 *    shared keys while the feature is off for its owner; own keys while the
 *    owner stores no key set with that client id. It resumes by itself once
 *    usable. Nobody calls an endpoint for this: `reconcileKeyAccess` runs
 *    wherever a connection is about to be used or shown (sync activity, sweep,
 *    connect-token, upstream, lists), so the state follows the feature.
 *  - Own-key connections get no webhooks (the shared webhook secret is not
 *    theirs): the 6-hourly sweep and the manual sync only.
 */
import { CREDENTIALS_KEY_MISSING, OWN_KEYS_REQUIRED } from '@shared/contracts/connections/credentials';

import type { Queryable } from '../core/db';
import { openSecret, sealSecret, SecretBoxOpenError, SecretBoxUnavailable } from '../core/secret-box';
import { HttpError } from '../core/validate';
import { isEnabled } from '../features';
import { getAggregator } from './registry';
import * as store from './store';
import type { ConnectionRow, StoredCredentials } from './store';
import type { BankAggregator, KeySource, ProviderCredentials } from './types';

/**
 * Bound into the ciphertext (AES-GCM additional data; the box adds the key
 * version): a secret opens only on the row it was sealed for, i.e. the same
 * user, provider AND client id. JSON so no value can run into the next.
 */
const secretContext = (userId: string, provider: string, clientId: string): string =>
  JSON.stringify(['connection_credentials', userId, provider, clientId]);

/** Encrypt and store the caller's own key set (replacing any earlier one). */
export async function storeOwnCredentials(
  db: Queryable,
  userId: string,
  provider: string,
  credentials: ProviderCredentials,
): Promise<StoredCredentials> {
  const sealed = await sealSecret(credentials.clientSecret, secretContext(userId, provider, credentials.clientId));
  return store.saveCredentials(db, {
    userId,
    provider,
    clientId: credentials.clientId,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    keyVersion: sealed.keyVersion,
  });
}

/** Decrypt a stored key set. Throws SecretBoxUnavailable / SecretBoxOpenError. */
export async function openOwnCredentials(row: StoredCredentials): Promise<ProviderCredentials> {
  const clientSecret = await openSecret(
    { ciphertext: new Uint8Array(row.secret_ciphertext), nonce: new Uint8Array(row.secret_nonce), keyVersion: row.key_version },
    secretContext(row.user_id, row.provider, row.client_id),
  );
  return { clientId: row.client_id, clientSecret };
}

/** May this user use the installation's shared keys? Read from the database on every call. */
export const sharedKeysAllowed = (db: Queryable, userId: string): Promise<boolean> => isEnabled(db, 'shared-pluggy-key', userId);

/**
 * Bring one user's connections in line with what they may use now: pause the
 * ones whose key set is not usable, resume the paused ones whose key set is.
 * Cheap and idempotent (one feature read, two updates).
 */
export async function reconcileKeyAccess(db: Queryable, userId: string): Promise<void> {
  await store.reconcilePausedConnections(db, userId, await sharedKeysAllowed(db, userId));
}

/** Why no aggregator could be built for a key set. */
export type KeyAccessProblem =
  /** No own key set and the shared keys are not allowed for this user. */
  | 'own_keys_required'
  /** The key set is the shared one and the provider's env keys are missing (or the provider is unknown). */
  | 'not_configured'
  /** The own secret cannot be decrypted: no master key here, or it changed. */
  | 'secret_unavailable'
  /** An own-key connection whose owner stores no key set with its client id. */
  | 'own_keys_missing';

export type KeyAccess =
  | { ok: true; aggregator: BankAggregator; keySource: KeySource; keyClientId: string | null }
  | { ok: false; problem: KeyAccessProblem };

async function ownAccess(provider: string, row: StoredCredentials): Promise<KeyAccess> {
  let credentials: ProviderCredentials;
  try {
    credentials = await openOwnCredentials(row);
  } catch (err) {
    if (err instanceof SecretBoxUnavailable || err instanceof SecretBoxOpenError) return { ok: false, problem: 'secret_unavailable' };
    throw err;
  }
  const aggregator = getAggregator(provider, credentials);
  if (!aggregator) return { ok: false, problem: 'not_configured' };
  return { ok: true, aggregator, keySource: 'own', keyClientId: row.client_id };
}

function sharedAccess(provider: string): KeyAccess {
  const aggregator = getAggregator(provider);
  if (!aggregator) return { ok: false, problem: 'not_configured' };
  return { ok: true, aggregator, keySource: 'shared', keyClientId: null };
}

/** The key set a NEW connection of this user gets: own wins, else shared when allowed. */
export async function keyAccessForNewConnection(db: Queryable, userId: string, provider: string): Promise<KeyAccess> {
  const own = await store.getCredentials(db, userId, provider);
  if (own) return ownAccess(provider, own);
  if (!(await sharedKeysAllowed(db, userId))) return { ok: false, problem: 'own_keys_required' };
  return sharedAccess(provider);
}

/**
 * Every key set this user may use for `provider` right now, in preference
 * order (own first). Registering a new item probes these to find the one the
 * item actually lives in. `problem` is why the list is empty.
 */
export async function usableKeySets(
  db: Queryable,
  userId: string,
  provider: string,
): Promise<{ usable: Array<Extract<KeyAccess, { ok: true }>>; problem: KeyAccessProblem }> {
  const usable: Array<Extract<KeyAccess, { ok: true }>> = [];
  let problem: KeyAccessProblem = 'own_keys_required';
  const own = await store.getCredentials(db, userId, provider);
  if (own) {
    const access = await ownAccess(provider, own);
    if (access.ok) usable.push(access);
    else problem = access.problem;
  }
  if (await sharedKeysAllowed(db, userId)) {
    const access = sharedAccess(provider);
    if (access.ok) usable.push(access);
    else if (!own) problem = access.problem;
  }
  return { usable, problem };
}

/**
 * The aggregator for an EXISTING connection, on the key set that created it.
 * `enforceFeature: false` skips only the shared-keys feature check: removing
 * a paused shared-key connection upstream is still allowed (cleanup is not
 * "using" the keys to connect or sync).
 */
export async function keyAccessForConnection(
  db: Queryable,
  row: Pick<ConnectionRow, 'user_id' | 'provider' | 'key_source' | 'key_client_id'>,
  options: { enforceFeature?: boolean } = {},
): Promise<KeyAccess> {
  if (row.key_source === 'own') {
    const own = await store.getCredentials(db, row.user_id, row.provider);
    if (!own || own.client_id !== row.key_client_id) return { ok: false, problem: 'own_keys_missing' };
    return ownAccess(row.provider, own);
  }
  if ((options.enforceFeature ?? true) && !(await sharedKeysAllowed(db, row.user_id))) {
    return { ok: false, problem: 'own_keys_required' };
  }
  return sharedAccess(row.provider);
}

export const OWN_KEYS_REQUIRED_MESSAGE =
  "Add your own Pluggy keys to connect a bank: the app's shared keys are not available for your account.";

/** The HTTP answer for a key-access problem (handlers only). */
export function keyAccessHttpError(problem: KeyAccessProblem, provider: string): HttpError {
  switch (problem) {
    case 'own_keys_required':
      return new HttpError(403, OWN_KEYS_REQUIRED_MESSAGE, OWN_KEYS_REQUIRED);
    case 'own_keys_missing':
      return new HttpError(403, 'The Pluggy keys this bank was connected with are no longer saved. Save that key set again.', OWN_KEYS_REQUIRED);
    case 'secret_unavailable':
      return new HttpError(503, 'Your saved Pluggy keys cannot be read on this server right now. Save them again, or try later.', CREDENTIALS_KEY_MISSING);
    case 'not_configured':
      return new HttpError(503, `connections provider ${provider} is not configured`, 'provider_not_configured', { provider });
  }
}
