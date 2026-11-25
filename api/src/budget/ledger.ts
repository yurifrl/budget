/**
 * Budget's ledger write API for other features (G5). The connections sync
 * engine writes imported bank rows into budget's `transactions`/`payees`
 * through this module only (exported from the budget barrel); it is built on
 * the same functions budget's own routes use:
 *
 * - payees: `loadRenameRules` + `applyRules` + `resolveImportedPayee`
 *   (domain/transactions.ts), the /bulk import path: a text that names an account's
 *   transfer payee leaves the row ordinary and returns the account as a hint
 *   (`setTransferHint`), never a payee-only half transfer;
 * - balances: `applyBalanceDeltas` (domain/transactions.ts);
 * - transfers between own accounts: `linkTransfers` (domain/transfer-links.ts;
 *   `linkCardPayments` is its former name, kept for callers);
 * - row writes: store/transactions.ts;
 * - account currency (G1): `adoptAccountCurrency` (store/accounts.ts), set
 *   from the provider only while the account has none.
 *
 * Sync keeps its own observable behaviour where it differed from budget's
 * routes (docs/decisions.md, phase 5b): payee names are stored verbatim
 * (not trimmed) once non-blank, rules load once per resolver, and the import
 * row shape (cleared from the bank, unapproved, no memo/category, no ON
 * CONFLICT) is its own store function.
 */
import type { PoolClient } from 'pg';

import { applyRules, type RenameRule } from '@shared/domain/payees';
import { loadRenameRules, resolveImportedPayee } from './domain/transactions';

export { applyBalanceDeltas, type BalanceDelta } from './domain/transactions';
export { linkTransfers, linkTransfers as linkCardPayments } from './domain/transfer-links';
export { adoptAccountCurrency } from './store/accounts';
export { setTransferHint } from './store/transfers';
export {
  insertImportedTransaction,
  refreshImportedTransaction,
  tombstoneTransaction,
  type ImportedTransaction,
} from './store/transactions';

/**
 * A payee resolved for an imported row: id (null when blank) and the stored
 * name (rule-rewritten; for a text that names an account, the raw text of the
 * ordinary payee). `transferAccountId`: the account the text pointed at, to be
 * recorded with `setTransferHint` once the row exists.
 */
export interface ResolvedPayee {
  id: string | null;
  name: string;
  transferAccountId: string | null;
}

export interface ImportPayeeResolver {
  resolve(rawName: string): Promise<ResolvedPayee>;
}

/**
 * Rule-rewritten payee resolution for one budget inside the caller's
 * transaction, cached per raw (trimmed) name; the budget's rename rules are
 * read once, on the first non-blank name. Create-or-find by the rewritten
 * name, kept verbatim; blank names (raw or rewritten) resolve to
 * `{ id: null, name: '' }`.
 */
export function createImportPayeeResolver(client: PoolClient, budgetId: string): ImportPayeeResolver {
  const cache = new Map<string, ResolvedPayee>();
  let rules: RenameRule[] | null = null;
  return {
    async resolve(rawName: string): Promise<ResolvedPayee> {
      const name = rawName.trim();
      if (!name) return { id: null, name: '', transferAccountId: null };
      if (!cache.has(name)) {
        if (!rules) rules = (await loadRenameRules(client, budgetId)).rows;
        const effective = applyRules(rules, name);
        const payee = await resolveImportedPayee(client, budgetId, name, effective, { verbatim: true });
        cache.set(name, { id: payee.id, name: payee.name, transferAccountId: payee.transferAccountId });
      }
      return cache.get(name)!;
    },
  };
}
