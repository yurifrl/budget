/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as adminUserContracts from './admin-users';
import * as meContracts from './me';
import * as passwordContracts from './password';
import * as providerContracts from './providers';

export * from './admin-users';
export * from './me';
export * from './password';
export * from './providers';
export const contracts = collectContracts(meContracts, providerContracts, passwordContracts, adminUserContracts);
