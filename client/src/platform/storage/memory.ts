import type { KVStore } from './types';

/** In-memory {@link KVStore} for tests and previews. */
export class MemoryKVStore implements KVStore {
  private map = new Map<string, string>();

  constructor(initial?: Record<string, unknown>) {
    if (initial) {
      for (const [k, v] of Object.entries(initial)) {
        this.map.set(k, JSON.stringify(v));
      }
    }
  }

  async get<T>(key: string, fallback: T): Promise<T> {
    const raw = this.map.get(key);
    if (raw == null) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    this.map.set(key, JSON.stringify(value));
  }

  async remove(key: string): Promise<void> {
    this.map.delete(key);
  }
}
