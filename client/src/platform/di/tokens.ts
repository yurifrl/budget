/**
 * Core service tokens registered by the composition root.
 *
 * These are the cross-cutting services every module may depend on. Modules
 * resolve them via injection — never by importing the concrete implementation.
 */

import type { AppConfig } from '../config';
import type { KVStore } from '../storage/types';
import { token } from './container';

export const Tokens = {
  /** Resolved application configuration (contains API base URL). */
  Config: token<AppConfig>('Config'),
  /** Key-value persistence abstraction (AsyncStorage in production). */
  Storage: token<KVStore>('Storage'),
} as const;
