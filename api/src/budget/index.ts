/**
 * Budget feature barrel (the server analog of a module barrel): mounts the
 * budget routers under their public prefixes and owns the budget background
 * tick. Mount order matters for readability only — no overlapping prefixes.
 */
import { Hono } from 'hono';

import { createSingleFlight, startInterval } from '../core/interval';
import type { AnyOperation } from '../core/operation';

import budgets, { operations as budgetsOps } from './routes/budgets';
import groups, { operations as groupsOps } from './routes/groups';
import categoryBundles, { operations as categoryBundlesOps } from './routes/category-bundles';
import categories, { operations as categoriesOps } from './routes/categories';
import accounts, { operations as accountsOps } from './routes/accounts';
import transactions, { operations as transactionsOps } from './routes/transactions';
import repeatRules, { operations as repeatRulesOps } from './routes/repeat-rules';
import { generateAllBudgets } from './domain/repeat-generation';
import assignments, { operations as assignmentsOps } from './routes/assignments';
import members, { operations as membersOps } from './routes/members';
import budgetExport, { operations as budgetExportOps } from './routes/budget-export';
import budgetRestore, { operations as budgetRestoreOps } from './routes/budget-restore';
import monthNotes, { operations as monthNotesOps } from './routes/month-notes';
import categoryNotes, { operations as categoryNotesOps } from './routes/category-notes';
import payees, { operations as payeesOps } from './routes/payees';
import categoryTargets, { operations as categoryTargetsOps } from './routes/category-targets';
import planAutoAssign, { operations as planAutoAssignOps } from './routes/plan-auto-assign';
import revision, { operations as revisionOps } from './routes/revision';
import payeeSuggestions, { operations as payeeSuggestionsOps } from './routes/payee-suggestions';
import transfers, { operations as transfersOps } from './routes/transfers';

const app = new Hono();

/**
 * Every budget operation, in mount order — the feature catalog the MCP server
 * and CLI generate from (aggregated by server/catalog.ts). Each route file
 * mounts these same declarations behind budgetAccess, so what is listed here
 * is exactly what is served.
 */
export const operations: readonly AnyOperation[] = [
  ...budgetsOps,
  ...groupsOps,
  ...categoriesOps,
  ...categoryBundlesOps,
  ...accountsOps,
  ...transactionsOps,
  ...repeatRulesOps,
  ...assignmentsOps,
  ...membersOps,
  ...budgetExportOps,
  ...budgetRestoreOps,
  ...monthNotesOps,
  ...categoryNotesOps,
  ...payeesOps,
  ...categoryTargetsOps,
  ...planAutoAssignOps,
  ...payeeSuggestionsOps,
  ...transfersOps,
  ...revisionOps,
];

/** Integration seam: the real accounts router, mounted by connections' tests. */
export { default as accountsRouter } from './routes/accounts';

/** "May this user reach this budget" as SQL, for features that read budget rows by another key (connections). */
export { accessibleBudgetSql } from './ownership';

/** Mount a budget-data route file behind budgetAccess (the categorize feature's router uses it). */
export { budgetRouter } from './router';

/** The assignable-category rule (live, visible, not internal/card-payment), for categorize accept. */
export { categoryAssignability, type CategoryAssignability } from './store/categories';

/** The transaction PATCH path, for categorize accept/undo (one write path, one budget revision). */
export { updateTransactionInClient } from './domain/transaction-update';

/** The existing payee categorization rule (fixed/auto/history), for features that answer it before the model (categorize). */
export { suggestedCategoryForPayee } from './domain/categorization';

/** The register's transfer plan (pending rows / suggestions), for features that read the same rows (categorize). */
export { transferOverview } from './domain/transfer-links';

/** The register's own transfer link/unlink, for categorize's transfer accept and undo. */
export { freeTransferCounterpart, linkByUser, transferMarksOf, unlinkTransfers } from './domain/transfer-links';
/** The row-level mark writer, for undo putting back exactly what a link replaced. */
export { setTransferMarks } from './store/transfers';
export type { StoredTransferMark } from './domain/transfer-matcher';

/**
 * The one rule for "could this row be the other leg of that transfer" and the
 * one window it is dated inside, for categorize's SQL (candidate rule, the facts
 * given to Jev, the accept-time re-check), which adds its own refusals.
 */
export { freeCounterpart, TRANSFER_PAIR_DAYS } from './store/transfers';

/** Ledger write API for the connections sync engine (imported rows, payees, balances, card payments). */
export * as ledger from './ledger';

app.route('/budgets', budgets);
app.route('/groups', groups);
app.route('/categories', categories);
app.route('/bundles', categoryBundles);
app.route('/accounts', accounts);
app.route('/transactions', transactions);
app.route('/repeat-rules', repeatRules);
app.route('/assignments', assignments);
app.route('/budgets/export', budgetExport);
app.route('/budgets/restore', budgetRestore);
app.route('/budget-members', members);
app.route('/month-notes', monthNotes);
app.route('/category-notes', categoryNotes);
app.route('/payees', payees);
app.route('/category-targets', categoryTargets);
app.route('/plan-auto-assign', planAutoAssign);
app.route('/payee-suggestions', payeeSuggestions);
app.route('/transfers', transfers);
app.route('/budget-revision', revision);

export default app;

/**
 * Boot/interval tick for repeat-rule occurrence generation (idempotent; run
 * first at boot, then on the interval). Env parsing stays in the entrypoint.
 */
export function startBudgetRepeatTick(intervalSeconds: number): void {
  const tick = createSingleFlight('Budget repeat-rule tick', generateAllBudgets);

  void tick();
  startInterval(tick, intervalSeconds * 1000);
}
