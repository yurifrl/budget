/**
 * Per-account CSV-mapping persistence for the import sheet.
 *
 * When a file has no recognizable bank layout, the user maps columns once;
 * the mapping is stored per account id (one bank layout per account in
 * practice) via the injected {@link KVStore}, so the next import prefills it.
 */

import { token } from '@/platform/di/container';
import type { KVStore } from '@/platform/storage/types';
import type { CsvMapping } from './types';

export interface ImportMappingStore {
  /** Load the saved mapping for an account; null when none saved yet. */
  load(accountId: string): Promise<CsvMapping | null>;
  /** Persist the mapping for an account. */
  save(accountId: string, mapping: CsvMapping): Promise<void>;
}

const key = (accountId: string): string => `budget.import.mapping.${accountId}`;

/** Default (empty) mapping an unmapped file starts from. */
export function emptyMapping(delimiter = ','): CsvMapping {
  return {
    delimiter,
    headerRow: 0,
    columns: { date: -1, payee: -1, memo: -1, outflow: -1, inflow: -1, amount: -1, category: -1 },
    chargePositive: false,
  };
}

export function createImportMappingStore(kv: KVStore): ImportMappingStore {
  return {
    load: (accountId) => kv.get<CsvMapping | null>(key(accountId), null),
    save: (accountId, mapping) => kv.set(key(accountId), mapping),
  };
}

/** DI token for the import mapping store. */
export const ImportMappingStoreToken = token<ImportMappingStore>('ImportMappingStore');
