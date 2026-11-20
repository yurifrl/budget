/**
 * Bank-connection pure helpers.
 *
 * The connect widget is a hosted web page driven inside a WebView; these
 * helpers encode the pieces of that protocol we control from the client:
 * which connection statuses require re-auth, how the widget URL is built
 * from the connect-token response, and how the widget's postMessage events
 * are classified.
 */

import type { AvatarPerson } from '@/domain/avatar';

import type { CreditDetailsJson, LinkedByJson } from '@/budget/data/connections';
import { personLabel, toAvatarPerson } from '@/domain/people';

/**
 * Generic connection lifecycle statuses (server/connections/types.ts) that
 * need a fresh auth — the account row surfaces a Reconnect CTA for them.
 */
export const AUTH_REQUIRED_STATUSES = ['unauthorized'] as const;

/** True when the connection's status requires the user to reconnect. */
export function requiresReauth(status: string): boolean {
  return (AUTH_REQUIRED_STATUSES as readonly string[]).includes(status);
}

/** Display label + pill tone for a connection's generic status. */
export function connectionStatusView(status: string): { label: string; tone: 'ok' | 'warn' | 'bad' | 'off' } {
  switch (status) {
    case 'connected':
      return { label: 'Synced', tone: 'ok' };
    case 'unauthorized':
      return { label: 'Action needed', tone: 'warn' };
    case 'quota_exhausted':
      return { label: 'Bank limit reached', tone: 'warn' };
    case 'paused':
      return { label: 'Paused · needs your keys', tone: 'warn' };
    case 'error':
      return { label: 'Sync error', tone: 'bad' };
    default:
      return { label: 'Disconnected', tone: 'off' };
  }
}

/** "dd/mm HH:MM" for an ISO timestamp — connection sync stamps aren't dates. */
export function formatSyncStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Widget URL for the connect WebView: the API's widget URL plus the token as
 * `?token=`. When the URL already carries the token (the connect-token
 * response may embed it) it is returned unchanged.
 */
export function buildWidgetUrl(widgetUrl: string, token: string): string {
  if (widgetUrl.includes('token=')) return widgetUrl;
  const sep = widgetUrl.endsWith('?') || widgetUrl.endsWith('&') ? '' : widgetUrl.includes('?') ? '&' : '?';
  return `${widgetUrl}${sep}token=${encodeURIComponent(token)}`;
}

/** Outcome of a connect widget postMessage event, or null when not terminal. */
export type WidgetOutcome = 'connected' | 'closed' | 'oauth';

/**
 * The bank-login URL a widget OAuth event carries — `{ message: url }` on
 * the relayed `connector-oauth-login` channel, or a `url`/`oauthUrl` field.
 */
export function oauthRelayUrl(data: unknown): string | null {
  const value = parseWidgetData(data);
  if (value == null || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  for (const key of ['url', 'oauthUrl', 'message']) {
    const candidate = record[key];
    if (typeof candidate === 'string' && /^https?:\/\//.test(candidate)) return candidate;
  }
  return null;
}

/**
 * Classify a widget message. The widget posts events as JSON strings or
 * objects (`{ event: 'CONNECTED', ... }`); we match on the flattened text:
 * anything containing `connected`/`success` is the item-created signal,
 * `cancel`/`close` is the user bailing. Everything else (open/progress
 * events, errors the widget keeps showing itself) is not terminal.
 */
export function classifyWidgetMessage(data: unknown): WidgetOutcome | null {
  // The relayed OAuth-login channel carries the bank URL in `message`, so the
  // flattened text alone can't distinguish it — match on the source field.
  const value = parseWidgetData(data);
  if (value != null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const source = record.source;
    if (source === 'connector-oauth-login' || source === 'item-oauth-login') return 'oauth';
    // The widget's own webview-bound OAuth relay: `{ type: 'OAUTH_OPEN',
    // message: <url> }` (window.open is unavailable inside the WebView).
    if (record.type === 'OAUTH_OPEN') return 'oauth';
  }
  const text = widgetMessageText(data);
  if (!text) return null;
  const t = text.toLowerCase();
  // AUTH/OAUTH statuses are flow stages, not outcomes (the OAuth window
  // posts back over the same channel once it finishes).
  if (/\b(auth|oauth)\b/.test(t)) return null;
  if (t.includes('connected') || t.includes('success')) return 'connected';
  if (t.includes('cancel') || t.includes('close')) return 'closed';
  return null;
}

/**
 * The upstream item id carried by a widget event, when the event includes
 * one — `itemId`/`item_id` on widget postMessage events, `item.id` (Pluggy's
 * `Item` shape) on SDK callbacks. Accepts the raw postMessage data or a
 * JSON-stringified variant.
 */
export function widgetItemId(data: unknown): string | null {
  const value = parseWidgetData(data);
  if (value == null || typeof value !== 'object') return null;
  if ('itemId' in value || 'item_id' in value) {
    const raw = 'itemId' in value ? value.itemId : value.item_id;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }
  if ('item' in value && value.item != null && typeof value.item === 'object' && 'id' in value.item) {
    const raw = value.item.id;
    return typeof raw === 'string' && raw.length > 0 ? raw : null;
  }
  return null;
}

/** Flatten postMessage data (JSON string, object, or nested payload) to text. */
function widgetMessageText(data: unknown): string | null {
  const value = parseWidgetData(data);
  if (typeof value === 'string' && value.length > 0) return value;
  if (value != null && typeof value === 'object') {
    if (!('event' in value || 'message' in value)) return null;
    const event = 'event' in value ? value.event : value.message;
    if (typeof event === 'string' && event.length > 0) return event;
    return null;
  }
  return null;
}

function parseWidgetData(data: unknown): unknown {
  if (typeof data !== 'string') return data;
  try {
    return JSON.parse(data);
  } catch {
    return data;
  }
}

/** Short label for a sync window in days (0 = all history). */
export function syncWindowLabel(days: number): string {
  if (days === 0) return 'All history';
  if (days === 365) return '1 year';
  return `${days}d`;
}

const PROVIDER_UNREADABLE =
  "Couldn't sync with the bank — the provider returned data we couldn't read. We'll retry on the next sync.";

/**
 * Human message for a connection error banner. Raw provider validation dumps
 * (a JSON array of zod issues after "provider request failed:") are replaced
 * by a short sentence; other messages pass through.
 */
export function humanizeConnectionError(message: string): string {
  if (/^provider request failed:\s*\[\s*\{/.test(message) || /"code"\s*:\s*"invalid_type"/.test(message)) {
    return PROVIDER_UNREADABLE;
  }
  return message;
}

/** "dd/mm" for an ISO date or timestamp; null when unparsable. */
function dueLabel(iso: string | null | undefined): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[3]}/${m[2]}` : null;
}

/** Structured bill / limit figures of a CREDIT upstream account (null = unknown). */
export interface CreditView {
  billCents: number | null;
  /** "dd/mm" of the bill (or card) due date. */
  due: string | null;
  usedCents: number | null;
  limitCents: number | null;
  /** limit - used, only when both are known and used <= limit. */
  availableCents: number | null;
  /** used / limit as a whole percent clamped to 0..100; null unless both known and limit > 0. */
  usedPct: number | null;
}

/** Pure view of a CREDIT account's bill and limit; null when nothing is reported. */
export function creditView(credit: CreditDetailsJson | null | undefined): CreditView | null {
  if (!credit) return null;
  const bill = credit.latestBill;
  const billCents = bill?.totalCents ?? null;
  const due = dueLabel(bill?.totalCents != null ? bill.dueDate : null) ?? dueLabel(credit.dueDate);
  const usedCents = credit.usedCents ?? null;
  const limitCents = credit.limitCents ?? null;
  const both = usedCents != null && limitCents != null;
  const view: CreditView = {
    billCents,
    due,
    usedCents,
    limitCents,
    availableCents: both && limitCents - usedCents >= 0 ? limitCents - usedCents : null,
    usedPct: both && limitCents > 0 ? Math.min(100, Math.max(0, Math.round((usedCents / limitCents) * 100))) : null,
  };
  return billCents == null && due == null && usedCents == null && limitCents == null ? null : view;
}

/**
 * One-line summary of a CREDIT upstream account's bill and limit, e.g.
 * "Bill R$ 17.123,34 · due 05/11 · limit used R$ 40.437,82 / R$ 84.260,00".
 * Null when there is nothing to show, so callers fall back to the balance.
 */
export function creditSummary(
  credit: CreditDetailsJson | null | undefined,
  fmt: (cents: number) => string,
): string | null {
  const v = creditView(credit);
  if (!v) return null;
  const parts: string[] = [];
  if (v.billCents != null) parts.push(`Bill ${fmt(v.billCents)}${v.due ? ` · due ${v.due}` : ''}`);
  else if (v.due) parts.push(`due ${v.due}`);
  if (v.usedCents != null && v.limitCents != null) parts.push(`limit used ${fmt(v.usedCents)} / ${fmt(v.limitCents)}`);
  else if (v.limitCents != null) parts.push(`limit ${fmt(v.limitCents)}`);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * THE adapter for "Linked by <avatar> Ana": the avatar person + display label
 * (name, else email) from a connection's / account's `linked_by`; null when
 * nobody is recorded (unlinked account, legacy row).
 */
export function linkedByView(linkedBy: LinkedByJson | null | undefined): { person: AvatarPerson; label: string } | null {
  if (!linkedBy) return null;
  return { person: toAvatarPerson(linkedBy), label: personLabel(linkedBy) };
}
