/**
 * Composition root wiring: builds the DI container, registers the services,
 * and creates the store. `app/_layout.tsx` calls `createRuntime()` once.
 */
import { createImportMappingStore, ImportMappingStoreToken } from '@/budget/import/mapping-store';
import { loadConfig } from '@/platform/config';
import { Container } from '@/platform/di/container';
import { Tokens } from '@/platform/di/tokens';
import { AsyncStorageKVStore } from '@/platform/storage/asyncStorage';

import { createAppStore, type AppStore } from './store';

export interface AppRuntime {
  container: Container;
  store: AppStore;
}

let runtime: AppRuntime | null = null;

/** Build the container + store. Idempotent. */
export function createRuntime(): AppRuntime {
  if (runtime) return runtime;

  const container = new Container();
  container.registerValue(Tokens.Config, loadConfig());
  container.register(Tokens.Storage, () => new AsyncStorageKVStore());
  container.register(ImportMappingStoreToken, (c) => createImportMappingStore(c.resolve(Tokens.Storage)));

  runtime = { container, store: createAppStore(container) };
  return runtime;
}
