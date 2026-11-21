/**
 * Pure rules of the Linked banks screen: what a connect-widget message means
 * for the running flow, which connections the list shows, and the row / list
 * strings. Wire-typed (connection rows), so it lives beside the screen.
 */

import type { ConnectionJson, ConnectionUpstreamJson } from '@/budget/data/connections';
import { t } from './i18n';
import { classifyWidgetMessage, formatSyncStamp, oauthRelayUrl, widgetItemId } from '../model/connections';

/** Which row shows the widget: 'new' = a new bank, an item id = re-auth, null = the list. */
export type ConnectFlowTarget = 'new' | string | null;

/** The itemId/connectionId params seed a re-auth flow (both are needed). */
export function initialFlowTarget(itemId: string | undefined, connectionId: string | undefined): ConnectFlowTarget {
  return itemId && connectionId ? itemId : null;
}

export type WidgetStep =
  /** OAuth connector: open `url` in the system browser (null = the event carried none). */
  | { kind: 'oauth'; url: string | null }
  /** The user closed the widget. */
  | { kind: 'closed' }
  /** Re-auth finished: refresh the existing connection. */
  | { kind: 'refresh'; connectionId: string }
  /** A new item was created: register it. */
  | { kind: 'register'; itemId: string }
  /** Not terminal, or nothing to do right now. */
  | { kind: 'ignore' };

/**
 * What a widget message asks of the flow. OAuth and close are honoured even
 * while a request is in flight; a success is ignored while busy, and a
 * new-bank success without an item id is ignored too (e.g. a mere
 * 'connected' ping — the widget's ITEM_RESPONSE carries the id).
 */
export function widgetStep(
  data: unknown,
  ctx: { flow: ConnectFlowTarget; connectionId: string | null; busy: boolean },
): WidgetStep {
  const outcome = classifyWidgetMessage(data);
  if (outcome === 'oauth') return { kind: 'oauth', url: oauthRelayUrl(data) };
  if (outcome === 'closed') return { kind: 'closed' };
  if (outcome !== 'connected') return { kind: 'ignore' };
  if (ctx.flow !== 'new' && ctx.connectionId) {
    return ctx.busy ? { kind: 'ignore' } : { kind: 'refresh', connectionId: ctx.connectionId };
  }
  if (ctx.busy) return { kind: 'ignore' };
  const itemId = widgetItemId(data);
  return itemId ? { kind: 'register', itemId } : { kind: 'ignore' };
}

/** The Connect Bank route; a registered new bank lands here. */
export const CONNECT_BANK_ROUTE = '/connect-bank';

/**
 * Where the app goes once a widget step has been fully handled: a registered
 * bank lands on Connect Bank; cancel (closed), re-auth refresh (stays on the
 * screen) and everything else navigate nowhere.
 */
export function stepSuccessRoute(step: Pick<WidgetStep, 'kind'>): typeof CONNECT_BANK_ROUTE | null {
  return step.kind === 'register' ? CONNECT_BANK_ROUTE : null;
}

/**
 * Disconnected rows are the graveyard of removed banks — their history lives
 * on in the ledger, but the list shows live banks only.
 */
export function visibleConnections<T extends Pick<ConnectionJson, 'status'>>(connections: readonly T[]): T[] {
  return connections.filter((r) => r.status !== 'disconnected');
}

/** The line under the title: how many banks are listed and how many are connected. */
export function banksHint(connections: readonly Pick<ConnectionJson, 'status'>[]): string {
  const visible = visibleConnections(connections).length;
  const connected = connections.filter((r) => r.status === 'connected').length;
  return visible === 0 ? t('list.none') : t('list.summary', { count: visible, connected });
}

/** A bank's display name: the institution, else the provider. */
export function connectionName(row: Pick<ConnectionJson, 'institution' | 'provider'>): string {
  return row.institution ?? row.provider;
}

/** Second line of a row: the reconnect prompt, or the last sync (falling back to when it was added). */
export function connectionSubline(
  row: Pick<ConnectionJson, 'environment' | 'created_at' | 'last_synced_at'>,
  reauth: boolean,
  stamp: (iso: string) => string = formatSyncStamp,
): string {
  const sandbox = row.environment === 'sandbox';
  if (reauth) {
    return sandbox ? t('row.reauthSandbox') : t('row.reauthAdded', { stamp: stamp(row.created_at) });
  }
  if (row.last_synced_at) {
    const synced = stamp(row.last_synced_at);
    return sandbox ? t('row.lastSyncSandbox', { stamp: synced }) : t('row.lastSync', { stamp: synced });
  }
  const added = stamp(row.created_at);
  return sandbox ? t('row.lastAddedSandbox', { stamp: added }) : t('row.lastAdded', { stamp: added });
}

/** How many of a connection's upstream accounts are linked to budget accounts. */
export function linkedAccountCount(up: Pick<ConnectionUpstreamJson, 'accounts'> | undefined): number {
  return up?.accounts?.filter((a) => a.linkedAccountId != null).length ?? 0;
}
