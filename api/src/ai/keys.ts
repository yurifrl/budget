/**
 * Which AI key a request or a categorization run uses, and whether the caller
 * may use it right now. Own key wins; else the installation's shared key when
 * feature 'shared-ai-key' is on for the caller; else `own_ai_key_required`.
 * There is no paused state: nothing upstream is tied to the key (unlike a
 * Pluggy connection), so removing or changing the key only changes the next
 * classification.
 *
 * Called from handlers and (later) Temporal activities only: it reads features,
 * env and the database; never from a workflow file.
 */
import {
  AI_ENCRYPTION_MISSING,
  AI_KEY_REQUIRED,
  AI_KEY_UNREADABLE,
  AI_SHARED_KEY_MISSING,
  AI_SHARED_MODEL_MISSING,
  isAiProviderId,
  type AiKeyProblemId,
  type AiProviderId,
} from '@shared/contracts/ai';

import type { Queryable } from '../core/db';
import { openSecret, sealSecret, SecretBoxOpenError, SecretBoxUnavailable } from '../core/secret-box';
import { HttpError } from '../core/validate';
import { isEnabled } from '../features';
import { sharedAiConfig } from './env';
import { makeResolvedAiKey, type ResolvedAiKey } from './providers';
import { getSharedAiModel } from './settings';
import * as store from './store';

/**
 * Bound into the ciphertext (AES-GCM additional data; the box adds the key
 * version): a secret opens only on the row it was sealed for, i.e. the same
 * user AND provider. JSON so no value can run into the next. A ciphertext
 * copied onto another provider's row does not open, so a database writer
 * cannot redirect a key to another vendor.
 */
const secretContext = (userId: string, provider: string): string => JSON.stringify(['ai_credentials', userId, provider]);

/** Encrypt and store the caller's key, replacing any earlier one. */
export async function storeOwnKey(
  db: Queryable,
  userId: string,
  provider: AiProviderId,
  apiKey: string,
  model: string | null,
): Promise<store.AiCredentialRow> {
  const sealed = await sealSecret(apiKey, secretContext(userId, provider));
  return store.saveCredential(db, {
    userId,
    provider,
    ciphertext: sealed.ciphertext,
    nonce: sealed.nonce,
    keyVersion: sealed.keyVersion,
    model,
  });
}

/** Decrypt a stored key. Throws SecretBoxUnavailable / SecretBoxOpenError. */
export async function openOwnKey(row: store.AiCredentialRow): Promise<string> {
  return openSecret(
    { ciphertext: new Uint8Array(row.secret_ciphertext), nonce: new Uint8Array(row.secret_nonce), keyVersion: row.key_version },
    secretContext(row.user_id, row.provider),
  );
}

/** May this user use the installation's shared AI key? Read from the database on every call. */
export const sharedAiAllowed = (db: Queryable, userId: string): Promise<boolean> => isEnabled(db, 'shared-ai-key', userId);

/**
 * Why no AI key could be resolved. The closed list lives in
 * shared/src/contracts/ai/outputs.ts because categorize_run_status carries it
 * to the client; this alias keeps the API's name.
 */
export type AiKeyProblem = AiKeyProblemId;

export type AiKeyResolution = { ok: true; key: ResolvedAiKey } | { ok: false; problem: AiKeyProblem };

/** Own key wins, else the shared key when feature + env allow it. */
export async function resolveAiKey(db: Queryable, userId: string): Promise<AiKeyResolution> {
  const own = await store.getCredential(db, userId);
  if (own) {
    const provider = isAiProviderId(own.provider) ? own.provider : null;
    if (!provider) return { ok: false, problem: 'unreadable' };
    try {
      const apiKey = await openOwnKey(own);
      return { ok: true, key: makeResolvedAiKey({ source: 'own', provider, model: own.model, apiKey, updatedAt: own.updated_at.toISOString() }) };
    } catch (err) {
      if (err instanceof SecretBoxUnavailable) return { ok: false, problem: 'encryption_missing' };
      if (err instanceof SecretBoxOpenError) return { ok: false, problem: 'unreadable' };
      throw err;
    }
  }
  if (!(await sharedAiAllowed(db, userId))) return { ok: false, problem: 'own_key_required' };
  const shared = sharedAiConfig();
  if (!shared) return { ok: false, problem: 'shared_key_missing' };
  const model = await getSharedAiModel(db);
  if (!model) return { ok: false, problem: 'shared_model_missing' };
  return { ok: true, key: makeResolvedAiKey({ source: 'shared', provider: shared.provider, model, apiKey: shared.apiKey, updatedAt: null }) };
}

/**
 * The shared key as shown in the caller's status: `available` means a run
 * could actually use it (feature on, valid key configured, model chosen).
 */
export async function sharedAiStatus(
  db: Queryable,
  userId: string,
): Promise<{ available: boolean; provider: AiProviderId | null; model: string | null }> {
  const allowed = await sharedAiAllowed(db, userId);
  const shared = allowed ? sharedAiConfig() : null;
  const model = shared ? await getSharedAiModel(db) : null;
  return { available: shared != null && model != null, provider: shared?.provider ?? null, model };
}

export const AI_KEY_REQUIRED_MESSAGE =
  "Add your own AI key to get category suggestions: the app's shared AI key is not available for your account.";

/** The HTTP answer for an AI-key problem (handlers only). */
export function aiKeyHttpError(problem: AiKeyProblem): HttpError {
  switch (problem) {
    case 'own_key_required':
      return new HttpError(403, AI_KEY_REQUIRED_MESSAGE, AI_KEY_REQUIRED);
    case 'shared_key_missing':
      return new HttpError(503, 'The shared AI key is not configured on this server.', AI_SHARED_KEY_MISSING);
    case 'shared_model_missing':
      return new HttpError(503, 'The shared AI key is configured, but no model is chosen for it.', AI_SHARED_MODEL_MISSING);
    case 'encryption_missing':
      return new HttpError(503, 'AI keys cannot be stored or read: this server has no encryption key configured.', AI_ENCRYPTION_MISSING);
    case 'unreadable':
      return new HttpError(503, 'Your saved AI key cannot be read on this server right now. Save it again, or try later.', AI_KEY_UNREADABLE);
  }
}
