/**
 * Contract catalog — every declared API operation CONTRACT across features, in
 * one list. Contracts only: zod + pure schema files, no handlers, hono or pg,
 * so the CLI, the MCP tool generator and the Expo app can import it. Handlers
 * stay private to each feature's routers.
 */
import type { OperationContract } from '@shared/operation-contract';
import { contracts as budgetContracts } from '@shared/contracts/budget';
import { contracts as categorizeContracts } from '@shared/contracts/categorize';
import { contracts as connectionsContracts } from '@shared/contracts/connections';
import { contracts as featuresContracts } from '@shared/contracts/features';
import { contracts as jevContracts } from '@shared/contracts/jev';
import { contracts as jobsContracts } from '@shared/contracts/jobs';
import { contracts as oauthContracts } from '@shared/contracts/oauth';
import { contracts as ratesContracts } from '@shared/contracts/rates';
import { contracts as userContracts } from '@shared/contracts/user';

export const contracts: readonly OperationContract[] = [
  ...budgetContracts,
  ...categorizeContracts,
  ...connectionsContracts,
  ...featuresContracts,
  ...jevContracts,
  ...jobsContracts,
  ...oauthContracts,
  ...ratesContracts,
  ...userContracts,
];
