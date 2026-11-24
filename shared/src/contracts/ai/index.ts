/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as credentialsContracts from './credentials';

export * from './credentials';
export * from './outputs';

export const contracts = collectContracts(credentialsContracts);
