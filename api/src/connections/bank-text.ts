/**
 * The bank's own text of a transaction, read out of the provider's stored object (`connection_transactions.raw_payload`).
 * The ONE expression: an adapter resolves a transaction's `description` as `typeof raw.description === 'string'` trimmed
 * (Pluggy: `(txn.description ?? '').trim()`), and everything that asks "what text did the bank send for this row" (the sync's
 * "did the bank change the text" decision, apply-to-past matching) reads the stored object through this function, so the
 * answers cannot drift apart. `adapters/pluggy/index.test.ts` checks the two agree.
 *
 * Null when the object does not say (no object stored, or no string `description` in it: rows older than raw storage).
 */
export function rawBankText(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') return null;
  const description = (raw as { description?: unknown }).description;
  return typeof description === 'string' ? description.trim() : null;
}
