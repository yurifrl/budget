/**
 * Connections registry — provider name → BankAggregator.
 *
 * One map of providers, sourced from the adapters barrel. The core (routes,
 * sync, poller) resolves adapters only through this module: unknown provider
 * → null (surfaces as 404), known-but-unconfigured → null via `configured()`
 * false (surfaces as 503). New aggregator = new adapter folder + one barrel
 * line; nothing here changes.
 */

import adapterEntries, { type AggregatorEntry } from './adapters';
import type { BankAggregator } from './types';

export type { AggregatorEntry };

/** Test seam: swap the adapter table (null restores the built-in registry). */
let entries: Record<string, AggregatorEntry> = adapterEntries;

export function setAggregators(map: Record<string, AggregatorEntry> | null): void {
  entries = map ?? adapterEntries;
}

/** Adapter for `provider`, or null when unknown or not configured. */
export function getAggregator(provider: string): BankAggregator | null {
  const entry = entries[provider];
  if (!entry || !entry.configured()) return null;
  return entry.create();
}

/** Whether the provider exists in the registry at all (config-independent). */
export function hasProvider(provider: string): boolean {
  return entries[provider] != null;
}

/** Providers whose credentials are present — boot diagnostics. */
export function configuredProviders(): string[] {
  return Object.keys(entries).filter((provider) => entries[provider].configured());
}
