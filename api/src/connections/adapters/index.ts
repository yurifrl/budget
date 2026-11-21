/**
 * Adapter registration barrel — the one place provider names are listed.
 *
 * Each provider contributes one entry: a factory for its BankAggregator and a
 * credentials-present check (delegated to the adapter's own config loader, so
 * the registry and core never read provider env keys). The provider-neutral
 * `../registry` imports this map; adding a bank = a new adapter folder plus
 * one line here.
 */

import type { BankAggregator, ProviderCredentials } from '../types';

import { PluggyAggregator } from './pluggy';
import { loadPluggyConfig, loadPluggyOwnConfig } from './pluggy/client';

export type AggregatorEntry = {
  /**
   * No argument: an aggregator on the installation's shared keys (provider
   * env). With `credentials`: one on that user's own key set; the shared keys
   * need not be configured for it.
   */
  create: (credentials?: ProviderCredentials) => BankAggregator;
  /** True when the provider's SHARED credentials are present in the environment. */
  configured: () => boolean;
};

const entries: Record<string, AggregatorEntry> = {
  pluggy: {
    create: (credentials) =>
      credentials ? new PluggyAggregator({ config: () => loadPluggyOwnConfig(credentials) }) : new PluggyAggregator(),
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
