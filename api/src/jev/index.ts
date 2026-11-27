/** Jev feature barrel: the decision call, the key routes and their operation catalog. */
import type { AnyOperation } from '../core/operation';
import jev, { operations as routeOperations } from './routes';

export const operations: readonly AnyOperation[] = [...routeOperations];

export default jev;
export {
  classifyTransaction,
  configureJevEnv,
  JEV_MAX_OPTIONS,
  JEV_MODEL,
  JEV_TOP,
  isRowFailure,
  isTransientFailure,
  JevFailure,
  NOT_TRANSFER_OPTION,
  probeJevKey,
  redactKey,
  ROW_FAILURE_KINDS,
  TRANSFER_OPTION,
  TRANSIENT_FAILURE_KINDS,
  sharedJevKey,
  type CategorizeFailureKind,
  type JevAnswer,
  type JevCall,
  type JevFacts,
  type JevOption,
  type JevSuggestion,
} from './call';
export {
  jevKeyStatus,
  jevUnavailableError,
  resolveJevKey,
  saveOwnKey,
  setJevProbeFetch,
  verifyKey,
  type JevKeyAccess,
} from './keys';
