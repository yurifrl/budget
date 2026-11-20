/** Contracts-only barrel: zod + schema files, no handlers, hono or pg. */
import { collectContracts } from '../../operation-contract';

import * as adminFeatureContracts from './admin-features';
import * as featureContracts from './features';

export * from './admin-features';
export * from './features';
export * from './outputs';
export const contracts = collectContracts(featureContracts, adminFeatureContracts);
