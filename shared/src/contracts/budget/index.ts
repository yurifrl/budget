/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as accountsContracts from './accounts';
import * as assignmentsContracts from './assignments';
import * as budgetExportContracts from './budget-export';
import * as budgetRestoreContracts from './budget-restore';
import * as budgetsContracts from './budgets';
import * as categoriesContracts from './categories';
import * as categoryBundlesContracts from './category-bundles';
import * as categoryNotesContracts from './category-notes';
import * as categoryTargetsContracts from './category-targets';
import * as groupsContracts from './groups';
import * as membersContracts from './members';
import * as monthNotesContracts from './month-notes';
import * as payeeSuggestionsContracts from './payee-suggestions';
import * as payeesContracts from './payees';
import * as planAutoAssignContracts from './plan-auto-assign';
import * as repeatRulesContracts from './repeat-rules';
import * as revisionContracts from './revision';
import * as transactionsContracts from './transactions';

export const contracts = collectContracts(
  accountsContracts,
  assignmentsContracts,
  budgetExportContracts,
  budgetRestoreContracts,
  budgetsContracts,
  categoriesContracts,
  categoryBundlesContracts,
  categoryNotesContracts,
  categoryTargetsContracts,
  groupsContracts,
  membersContracts,
  monthNotesContracts,
  payeeSuggestionsContracts,
  payeesContracts,
  planAutoAssignContracts,
  repeatRulesContracts,
  revisionContracts,
  transactionsContracts,
);

// Named contract exports for typed access (the app builds requests with them).
export * from './accounts';
export * from './assignments';
export * from './budget-export';
export * from './budget-restore';
export * from './budgets';
export * from './categories';
export * from './category-bundles';
export * from './category-notes';
export * from './category-targets';
export * from './groups';
export * from './members';
export * from './month-notes';
export * from './payee-suggestions';
export * from './payees';
export * from './plan-auto-assign';
export * from './repeat-rules';
export * from './revision';
export * from './transactions';
