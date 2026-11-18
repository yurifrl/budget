/**
 * Key-value persistence abstraction.
 *
 * Modules depend on this interface (resolved via DI) rather than importing
 * AsyncStorage directly, so persistence can be swapped (e.g. an in-memory fake
 * in tests). Values are stored as JSON.
 */
export interface KVStore {
  /** Read and JSON-parse a value, or return `fallback` when absent/invalid. */
  get<T>(key: string, fallback: T): Promise<T>;
  /** JSON-serialize and persist a value. */
  set<T>(key: string, value: T): Promise<void>;
  /** Remove a key. */
  remove(key: string): Promise<void>;
}

/** Minimal string secret store for credentials (Keychain on iOS; see secretStore). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
