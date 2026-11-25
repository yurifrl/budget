/**
 * Budget's ledger write API for other features (G5). The connections sync
 * engine writes imported bank rows into budget's `transactions`/`payees`
 * through this module only (exported from the budget barrel); it is built on
 * the same functions budget's own routes use:
 *
 * - payees: `loadRenameRules` + `resolveImportedPayee` (domain/transactions.ts), the
 *   /bulk import path: a matching renaming rule assigns its payee; a payee that is an
 *   account's transfer payee (by a rule or by the text) leaves the row ordinary and
 *   returns the account as a hint (`setTransferHint`), never a payee-only half transfer;
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

import { loadRenameRules, planImportedPayee, resolveImportedPayee, type RenameRules } from './domain/transactions';

export { applyBalanceDeltas, type BalanceDelta } from './domain/transactions';
export { linkTransfers, linkTransfers as linkCardPayments } from './domain/transfer-links';
export { adoptAccountCurrency } from './store/accounts';
export { clearTransferHints, setTransferHint } from './store/transfers';
export { lockBudgetImportWrites } from './store/rename-apply';
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
  /** The text `import_payee_name` keeps (the bank's text, also when no payee is stored). */
  importName: string;
  transferAccountId: string | null;
  /** The name an earlier sync stored for the same text (the transfer payee); see `ImportedPayeePlan.legacyName`. */
  legacyName: string | null;
  /**
   * The payee names stored for the same text before a matching rule assigned its payee
   * (a `contains` rule spliced it into the text: "Padaria 42"); see `ImportedPayeePlan.earlier`.
   * A row that has one of them is unchanged, never rewritten for that alone.
   */
  earlierNames: string[];
}

/** What a text means, without any write (no payee is created): for rows that already exist. */
export type PeekedPayee = Omit<ResolvedPayee, 'id'>;

export interface ImportPayeeResolver {
  /** Create-or-find the payee of a row being inserted or changed. */
  resolve(rawName: string): Promise<ResolvedPayee>;
  /** What the text means, with no write: for an existing row that may stay as it is. */
  peek(rawName: string): Promise<PeekedPayee>;
}

/**
 * Rule-rewritten payee resolution for one budget inside the caller's
 * transaction, cached per raw (trimmed) name; the budget's renaming rules are
 * read once, on the first non-blank name. Create-or-find by the rewritten
 * name, kept verbatim; blank names (raw or rewritten) resolve to
 * `{ id: null, name: '' }`.
 */
export function createImportPayeeResolver(client: PoolClient, budgetId: string): ImportPayeeResolver {
  const cache = new Map<string, ResolvedPayee>();
  let rules: RenameRules | null = null;
  const blank: ResolvedPayee = { id: null, name: '', importName: '', transferAccountId: null, legacyName: null, earlierNames: [] };
  const earlierNamesOf = (earlier: { name: string; legacyName: string | null }[]): string[] =>
    earlier.flatMap((e) => [e.name, ...(e.legacyName ? [e.legacyName] : [])]);
  return {
    async peek(rawName: string): Promise<PeekedPayee> {
      const name = rawName.trim();
      if (!name) return blank;
      rules ??= await loadRenameRules(client, budgetId);
      const plan = await planImportedPayee(client, budgetId, name, rules, { verbatim: true });
      return { name: plan.name, importName: plan.importName, transferAccountId: plan.transferAccountId, legacyName: plan.legacyName, earlierNames: earlierNamesOf(plan.earlier) };
    },
    async resolve(rawName: string): Promise<ResolvedPayee> {
      const name = rawName.trim();
      if (!name) return blank;
      if (!cache.has(name)) {
        rules ??= await loadRenameRules(client, budgetId);
        const payee = await resolveImportedPayee(client, budgetId, name, rules, { verbatim: true });
        cache.set(name, {
          id: payee.id,
          name: payee.name,
          importName: payee.importName,
          transferAccountId: payee.transferAccountId,
          legacyName: payee.legacyName,
          earlierNames: earlierNamesOf(payee.earlier),
        });
      }
      return cache.get(name)!;
    },
  };
}
