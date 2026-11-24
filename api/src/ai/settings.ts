/**
 * App-level AI settings backed by `app_settings` (0022). Today one setting:
 * the model the installation's SHARED key uses. An admin can change it without
 * a redeploy; `AI_SHARED_MODEL` is the fallback when no row is stored. A
 * malformed row is ignored (falls back), like the sync-window reader.
 */
import type { Queryable } from '../core/db';
import { aiEnv, AI_SHARED_MODEL_ENV } from './env';

export const AI_SHARED_MODEL_SETTING = 'aiSharedModel';

/**
 * Model id for the shared key: `app_settings.aiSharedModel` (a JSON string)
 * wins, else `AI_SHARED_MODEL`, else null (no model chosen).
 */
export async function getSharedAiModel(db: Queryable): Promise<string | null> {
  const { rows } = await db.query<{ value: unknown }>('select value from public.app_settings where key = $1', [AI_SHARED_MODEL_SETTING]);
  const stored = rows[0]?.value;
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return aiEnv()[AI_SHARED_MODEL_ENV]?.trim() || null;
}
