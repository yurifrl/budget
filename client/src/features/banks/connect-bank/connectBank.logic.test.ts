import { describe, expect, test } from 'bun:test';

import type { ConnectionJson, UpstreamAccountJson } from '@/budget/data/connections';
import {
  stepSuccessRoute,
  banksHint,
  connectButtonLabel,
  connectionName,
  connectionSubline,
  initialFlowTarget,
  linkedAccountCount,
  rowNoticeSlot,
  visibleConnections,
  widgetStep,
} from './connectBank.logic';

const conn = (status: ConnectionJson['status']) => ({ status });
const stamp = (iso: string) => `<${iso}>`;

describe('initialFlowTarget', () => {
  test('re-auth needs both params; the target is the item id', () => {
    expect(initialFlowTarget('item-1', 'conn-1')).toBe('item-1');
    expect(initialFlowTarget('item-1', undefined)).toBeNull();
    expect(initialFlowTarget(undefined, 'conn-1')).toBeNull();
    expect(initialFlowTarget('', 'conn-1')).toBeNull();
  });
});

describe('widgetStep', () => {
  const newFlow = { flow: 'new', connectionId: null, busy: false } as const;
  const reauth = { flow: 'item-1', connectionId: 'conn-1', busy: false };
  const connected = { event: 'CONNECTED', itemId: 'item-9' };

  test('an OAuth event opens its URL, even while busy', () => {
    const data = { source: 'connector-oauth-login', message: 'https://bank.example/login' };
    expect(widgetStep(data, newFlow)).toEqual({ kind: 'oauth', url: 'https://bank.example/login' });
    expect(widgetStep(data, { ...newFlow, busy: true })).toEqual({ kind: 'oauth', url: 'https://bank.example/login' });
  });

  test('an OAuth event without a usable URL reports null', () => {
    expect(widgetStep({ type: 'OAUTH_OPEN', message: 'not a url' }, newFlow)).toEqual({ kind: 'oauth', url: null });
  });

  test('a close event closes, even while busy', () => {
    expect(widgetStep({ event: 'CLOSE' }, { ...reauth, busy: true })).toEqual({ kind: 'closed' });
  });

  test('non-terminal messages are ignored', () => {
    expect(widgetStep({ event: 'OPEN' }, newFlow)).toEqual({ kind: 'ignore' });
    expect(widgetStep(null, newFlow)).toEqual({ kind: 'ignore' });
  });

  test('re-auth success refreshes the existing connection (no item id needed)', () => {
    expect(widgetStep({ event: 'CONNECTED' }, reauth)).toEqual({ kind: 'refresh', connectionId: 'conn-1' });
    expect(widgetStep(connected, { ...reauth, busy: true })).toEqual({ kind: 'ignore' });
  });

  test('new-bank success registers the item it carries', () => {
    expect(widgetStep(connected, newFlow)).toEqual({ kind: 'register', itemId: 'item-9' });
    expect(widgetStep({ event: 'CONNECTED', item: { id: 'item-7' } }, newFlow)).toEqual({ kind: 'register', itemId: 'item-7' });
  });

  test('new-bank success is ignored while busy or without an item id', () => {
    expect(widgetStep(connected, { ...newFlow, busy: true })).toEqual({ kind: 'ignore' });
    expect(widgetStep({ event: 'CONNECTED' }, newFlow)).toEqual({ kind: 'ignore' });
  });

  test("a 'new' flow registers even when a connection id lingers; a row flow without one registers too", () => {
    expect(widgetStep(connected, { flow: 'new', connectionId: 'conn-1', busy: false })).toEqual({ kind: 'register', itemId: 'item-9' });
    expect(widgetStep(connected, { flow: 'item-1', connectionId: null, busy: false })).toEqual({ kind: 'register', itemId: 'item-9' });
  });
});

describe('list', () => {
  const rows = [conn('connected'), conn('disconnected'), conn('unauthorized'), conn('connected'), conn('error')];

  test('disconnected banks are not listed', () => {
    expect(visibleConnections(rows).map((r) => r.status)).toEqual(['connected', 'unauthorized', 'connected', 'error']);
  });

  test('banksHint counts listed banks and connected ones', () => {
    expect(banksHint(rows)).toBe('4 banks · 2 connected');
    expect(banksHint([conn('unauthorized')])).toBe('1 bank · 0 connected');
  });

  test('nothing listed (none, or only disconnected) invites a first connection', () => {
    const empty = 'No banks linked yet. Connect one to pull accounts and transactions.';
    expect(banksHint([])).toBe(empty);
    expect(banksHint([conn('disconnected')])).toBe(empty);
  });

  test('connectButtonLabel says "a bank" until one is listed', () => {
    expect(connectButtonLabel([])).toBe('Connect a bank');
    expect(connectButtonLabel([conn('disconnected')])).toBe('Connect a bank');
    expect(connectButtonLabel([conn('unauthorized')])).toBe('Connect another bank');
    expect(connectButtonLabel(rows)).toBe('Connect another bank');
  });
});

describe('row strings', () => {
  const base = { environment: 'production', created_at: 'C', last_synced_at: 'S' } as const;

  test('connectionName prefers the institution', () => {
    expect(connectionName({ institution: 'Nubank', provider: 'pluggy' })).toBe('Nubank');
    expect(connectionName({ institution: null, provider: 'pluggy' })).toBe('pluggy');
  });

  test('synced: last sync stamp, sandbox suffixed', () => {
    expect(connectionSubline(base, false, stamp)).toBe('Last sync: <S>');
    expect(connectionSubline({ ...base, environment: 'sandbox' }, false, stamp)).toBe('Last sync: <S> · sandbox');
  });

  test('never synced: falls back to when it was added', () => {
    expect(connectionSubline({ ...base, last_synced_at: null }, false, stamp)).toBe('Last sync: added <C>');
  });

  test('re-auth: the reconnect prompt with the added stamp, or just "sandbox"', () => {
    expect(connectionSubline(base, true, stamp)).toBe('Reconnect to refresh credentials · added <C>');
    expect(connectionSubline({ ...base, environment: 'sandbox' }, true, stamp)).toBe('Reconnect to refresh credentials · sandbox');
  });

  test('linkedAccountCount counts linked upstream accounts; unreadable or missing lists count zero', () => {
    const acc = (linkedAccountId: string | null) => ({ linkedAccountId }) as UpstreamAccountJson;
    expect(linkedAccountCount({ accounts: [acc('a'), acc(null), acc('b')] })).toBe(2);
    expect(linkedAccountCount({ accounts: null })).toBe(0);
    expect(linkedAccountCount(undefined)).toBe(0);
  });
});

describe('stepSuccessRoute', () => {
  test('sends a registered bank to /connect-bank', () => {
    expect(stepSuccessRoute({ kind: 'register' })).toBe('/connect-bank');
  });
  test('navigates nowhere on cancel, refresh, oauth or ignore', () => {
    for (const kind of ['closed', 'refresh', 'oauth', 'ignore'] as const) {
      expect(stepSuccessRoute({ kind })).toBeNull();
    }
  });
});

describe('rowNoticeSlot', () => {
  test('wide rows keep the notice in the name column', () => {
    expect(rowNoticeSlot(true)).toBe('meta');
  });

  test('phone rows put it under the row, where it has the card width', () => {
    expect(rowNoticeSlot(false)).toBe('below');
  });
});
