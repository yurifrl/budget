/**
 * AI persistence (migration 0109). One row per user: their own AI key, sealed
 * by core/secret-box, plus the provider and the model they picked. Functions
 * take a Queryable; the secret never appears in this module's SELECTs beyond
 * the ciphertext columns.
 */
import type { Queryable } from '../core/db';

export interface AiCredentialRow {
  user_id: string;
  provider: string;
  secret_ciphertext: Buffer;
  secret_nonce: Buffer;
  key_version: number;
  model: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = 'user_id, provider, secret_ciphertext, secret_nonce, key_version, model, created_at, updated_at';

export async function getCredential(db: Queryable, userId: string): Promise<AiCredentialRow | null> {
  const { rows } = await db.query<AiCredentialRow>(`select ${COLUMNS} from public.ai_credentials where user_id = $1`, [userId]);
  return rows[0] ?? null;
}

/** Insert or replace the user's key (one row per user). */
export async function saveCredential(
  db: Queryable,
  input: {
    userId: string;
    provider: string;
    ciphertext: Uint8Array;
    nonce: Uint8Array;
    keyVersion: number;
    model: string | null;
  },
): Promise<AiCredentialRow> {
  const { rows } = await db.query<AiCredentialRow>(
    `insert into public.ai_credentials (user_id, provider, secret_ciphertext, secret_nonce, key_version, model)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (user_id) do update
       set provider = excluded.provider,
           secret_ciphertext = excluded.secret_ciphertext,
           secret_nonce = excluded.secret_nonce,
           key_version = excluded.key_version,
           model = excluded.model,
           updated_at = now()
     returning ${COLUMNS}`,
    [input.userId, input.provider, input.ciphertext, input.nonce, input.keyVersion, input.model],
  );
  return rows[0]!;
}

/** Remove the user's key; false when there was none. */
export async function deleteCredential(db: Queryable, userId: string): Promise<boolean> {
  const { rowCount } = await db.query('delete from public.ai_credentials where user_id = $1', [userId]);
  return (rowCount ?? 0) > 0;
}
