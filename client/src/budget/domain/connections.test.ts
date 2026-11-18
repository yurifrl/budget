import { describe, expect, it } from 'bun:test';

import {
  AUTH_REQUIRED_STATUSES,
  buildWidgetUrl,
  classifyWidgetMessage,
  connectionStatusView,
  creditSummary,
  creditView,
  humanizeConnectionError,
  linkedByView,
  oauthRelayUrl,
  syncWindowLabel,
  requiresReauth,
  widgetItemId,
} from './connections';

describe('requiresReauth', () => {
  it('flags the auth-requiring statuses', () => {
    expect(AUTH_REQUIRED_STATUSES).toContain('unauthorized');
    for (const status of AUTH_REQUIRED_STATUSES) expect(requiresReauth(status)).toBe(true);
  });

  it('does not flag healthy or inactive statuses', () => {
    for (const status of ['connected', 'error', 'disconnected', '']) {
      expect(requiresReauth(status)).toBe(false);
    }
  });
});

describe('connectionStatusView', () => {
  it('maps every lifecycle status onto a display label and tone', () => {
    expect(connectionStatusView('connected')).toEqual({ label: 'Synced', tone: 'ok' });
    expect(connectionStatusView('unauthorized')).toEqual({ label: 'Action needed', tone: 'warn' });
    expect(connectionStatusView('error')).toEqual({ label: 'Sync error', tone: 'bad' });
    expect(connectionStatusView('disconnected')).toEqual({ label: 'Disconnected', tone: 'off' });
  });
});

describe('buildWidgetUrl', () => {
  it('appends the token to a bare widget URL', () => {
    expect(buildWidgetUrl('https://connect.example.com/connect', 'tok-1')).toBe(
      'https://connect.example.com/connect?token=tok-1',
    );
  });

  it('appends with & when the URL already has a query', () => {
    expect(buildWidgetUrl('https://connect.example.com/connect?widgetUrl=x', 't&k')).toBe(
      'https://connect.example.com/connect?widgetUrl=x&token=t%26k',
    );
  });

  it('returns the URL unchanged when it already carries the token', () => {
    const url = 'https://connect.example.com/connect?token=abc';
    expect(buildWidgetUrl(url, 'other')).toBe(url);
  });
});

describe('classifyWidgetMessage', () => {
  it('classifies connected events (JSON string and object)', () => {
    expect(classifyWidgetMessage('{"event":"CONNECTED","itemId":"i-1"}')).toBe('connected');
    expect(classifyWidgetMessage({ event: 'SUCCESS' })).toBe('connected');
    expect(classifyWidgetMessage('connected')).toBe('connected');
  });

  it('classifies cancel/close events', () => {
    expect(classifyWidgetMessage('{"event":"CANCELED"}')).toBe('closed');
    expect(classifyWidgetMessage({ event: 'window.close' })).toBe('closed');
  });

  it('returns null for non-terminal events', () => {
    expect(classifyWidgetMessage('{"event":"OPEN"}')).toBeNull();
    expect(classifyWidgetMessage({ event: 'ITEM_LOGIN_PAGE' })).toBeNull();
    expect(classifyWidgetMessage(null)).toBeNull();
    expect(classifyWidgetMessage('')).toBeNull();
  });

  it('classifies the relayed OAuth-login channel as oauth', () => {
    expect(
      classifyWidgetMessage({ source: 'connector-oauth-login', message: 'https://bank.example/oauth?x=1' }),
    ).toBe('oauth');
    // The widget's own webview-bound relay type.
    expect(classifyWidgetMessage({ type: 'OAUTH_OPEN', message: 'https://bank.example/login' })).toBe('oauth');
    expect(
      classifyWidgetMessage('{"source":"connector-oauth-login","message":"https://bank.example/oauth?x=1"}'),
    ).toBe('oauth');
  });
});

describe('oauthRelayUrl', () => {
  it('extracts the URL from the relayed oauth message', () => {
    expect(oauthRelayUrl({ source: 'connector-oauth-login', message: 'https://bank.example/oauth' })).toBe(
      'https://bank.example/oauth',
    );
    expect(oauthRelayUrl('{"message":"https://bank.example/oauth?state=1"}')).toBe(
      'https://bank.example/oauth?state=1',
    );
    expect(oauthRelayUrl({ url: 'https://bank.example' })).toBe('https://bank.example');
  });

  it('returns null for non-URL payloads', () => {
    expect(oauthRelayUrl({ message: 'not a url' })).toBeNull();
    expect(oauthRelayUrl(null)).toBeNull();
    expect(oauthRelayUrl('{}')).toBeNull();
  });
});

describe('widgetItemId', () => {
  it('extracts itemId from JSON-string and object events', () => {
    expect(widgetItemId('{"event":"CONNECTED","itemId":"i-9"}')).toBe('i-9');
    expect(widgetItemId({ event: 'CONNECTED', itemId: 'i-2' })).toBe('i-2');
    expect(widgetItemId({ item_id: 'snake' })).toBe('snake');
  });

  it('extracts the id from a Pluggy Item payload (SDK shape)', () => {
    expect(widgetItemId({ item: { id: 'pluggy-item-1' } })).toBe('pluggy-item-1');
    expect(widgetItemId('{"item":{"id":"pluggy-item-2","status":"ONLINE"}}')).toBe('pluggy-item-2');
  });

  it('returns null when the event carries no item id', () => {
    expect(widgetItemId('{"event":"CONNECTED"}')).toBeNull();
    expect(widgetItemId({ item: { status: 'ONLINE' } })).toBeNull();
    expect(widgetItemId('not json')).toBeNull();
    expect(widgetItemId(null)).toBeNull();
  });
});

describe('syncWindowLabel', () => {
  it('labels presets and custom day counts', () => {
    expect(syncWindowLabel(0)).toBe('All history');
    expect(syncWindowLabel(365)).toBe('1 year');
    expect(syncWindowLabel(45)).toBe('45d');
  });
});

describe('humanizeConnectionError', () => {
  it('replaces raw zod dumps with a human sentence', () => {
    const raw =
      'provider request failed: [{"expected":"string","code":"invalid_type","path":[0,"creditCardMetadata","billId"],"message":"Invalid input"}]';
    const out = humanizeConnectionError(raw);
    expect(out).toContain("Couldn't sync with the bank");
    expect(out).not.toContain('invalid_type');
  });
  it('passes other messages through', () => {
    expect(humanizeConnectionError('provider request failed: item is processing')).toBe(
      'provider request failed: item is processing',
    );
  });
});

describe('creditSummary', () => {
  const fmt = (c: number) => 'R$' + (c / 100).toFixed(2);
  const empty = { limitCents: null, availableCents: null, usedCents: null, minimumPaymentCents: null, dueDate: null };
  it('shows bill, due date and limit used', () => {
    const credit = {
      ...empty,
      limitCents: 8_426_000,
      usedCents: 4_043_782,
      latestBill: { totalCents: 1_712_334, dueDate: '2026-11-05T00:00:00.000Z', minimumPaymentCents: null },
    };
    expect(creditSummary(credit, fmt)).toBe('Bill R$17123.34 · due 05/11 · limit used R$40437.82 / R$84260.00');
  });
  it('returns null when nothing is reported', () => {
    expect(creditSummary(null, fmt)).toBeNull();
    expect(creditSummary({ ...empty, latestBill: null }, fmt)).toBeNull();
  });
});

describe('creditView', () => {
  const empty = { limitCents: null, availableCents: null, usedCents: null, minimumPaymentCents: null, dueDate: null };
  it('full data', () => {
    const v = creditView({
      ...empty,
      limitCents: 8_426_000,
      usedCents: 4_043_782,
      latestBill: { totalCents: 1_712_334, dueDate: '2026-11-05T00:00:00.000Z', minimumPaymentCents: null },
    });
    expect(v).toEqual({ billCents: 1_712_334, due: '05/11', usedCents: 4_043_782, limitCents: 8_426_000, availableCents: 4_382_218, usedPct: 48 });
  });
  it('no bill: only due date from the card', () => {
    const v = creditView({ ...empty, dueDate: '2026-11-07', latestBill: null });
    expect(v).toMatchObject({ billCents: null, due: '07/11', usedPct: null });
  });
  it('limit only', () => {
    expect(creditView({ ...empty, limitCents: 1000, latestBill: null })).toMatchObject({ limitCents: 1000, usedCents: null, availableCents: null, usedPct: null });
  });
  it('used above limit clamps to 100% and has no availability', () => {
    expect(creditView({ ...empty, limitCents: 1000, usedCents: 1500, latestBill: null })).toMatchObject({ usedPct: 100, availableCents: null });
  });
  it('null when nothing is reported', () => {
    expect(creditView(null)).toBeNull();
    expect(creditView({ ...empty, latestBill: null })).toBeNull();
  });
});

describe('linkedByView', () => {
  it('maps linked_by to the avatar person + label (name, else email)', () => {
    const avatar = { seed: 's1', image_version: 3 };
    expect(linkedByView({ user_id: 'u1', name: ' Ana ', email: 'ana@x.io', avatar })).toEqual({
      person: { id: 'u1', avatar, name: 'Ana', email: 'ana@x.io' },
      label: 'Ana',
    });
    expect(linkedByView({ user_id: 'u2', name: null, email: 'bo@x.io', avatar })?.label).toBe('bo@x.io');
  });

  it('null / undefined renders nothing', () => {
    expect(linkedByView(null)).toBeNull();
    expect(linkedByView(undefined)).toBeNull();
  });
});
