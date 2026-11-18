/**
 * Adapter registration barrel — the one place provider names are listed.
 *
 * Each provider contributes one entry: a factory for its BankAggregator and a
 * credentials-present check (delegated to the adapter's own config loader, so
 * the registry and core never read provider env keys). The provider-neutral
 * `../registry` imports this map; adding a bank = a new adapter folder plus
 * one line here.
 */

import type { BankAggregator } from '../types';

import { PluggyAggregator } from './pluggy';
import { loadPluggyConfig } from './pluggy/client';

export type AggregatorEntry = {
  create: () => BankAggregator;
  /** True when the provider's credentials are present in the environment. */
  configured: () => boolean;
};

const entries: Record<string, AggregatorEntry> = {
  pluggy: {
    create: () => new PluggyAggregator(),
    configured: () => {
      try {
        loadPluggyConfig();
        return true;
      } catch {
        return false;
      }
    },
  },
};

export default entries;
