import { describe, expect, test } from 'bun:test';

import type { ConnectionUpstreamJson, UpstreamAccountJson } from '@/budget/data/connections';
import { connectedToLabel, findLinkedUpstream, unmatchedLinkHint, workingCents } from './accountEdit.logic';

const up = (externalId: string, linkedAccountId: string | null) => ({ externalId, linkedAccountId }) as unknown as UpstreamAccountJson;
const entry = (id: string, accounts: UpstreamAccountJson[] | null) =>
  ({ connection: { id }, accounts }) as unknown as ConnectionUpstreamJson;

describe('workingCents', () => {
  test('cleared + uncleared, milliunits to cents', () => {
    expect(workingCents({ cleared_balance: 123450, uncleared_balance: -23450 })).toBe(10000);
    expect(workingCents({ cleared_balance: 0, uncleared_balance: 0 })).toBe(0);
    expect(workingCents({ cleared_balance: -50000, uncleared_balance: 0 })).toBe(-5000);
  });
});

describe('findLinkedUpstream', () => {
  const a = up('x1', null);
  const b = up('x2', 'acc-1');
  const c = up('x3', 'acc-2');
  const upstream = [entry('c1', [a]), entry('c2', null), entry('c3', [b, c])];

  test('finds the upstream row linked to the account and its connection entry', () => {
    const hit = findLinkedUpstream(upstream, 'acc-1');
    expect(hit?.account).toBe(b);
    expect(hit?.entry).toBe(upstream[2]);
  });

  test('null when nothing links here, including unreadable (null) account lists', () => {
    expect(findLinkedUpstream(upstream, 'acc-9')).toBeNull();
    expect(findLinkedUpstream([entry('c2', null)], 'acc-1')).toBeNull();
    expect(findLinkedUpstream([], 'acc-1')).toBeNull();
  });

  test('the first match in connection order wins', () => {
    const dup = up('x9', 'acc-1');
    const hit = findLinkedUpstream([entry('c0', [dup]), ...upstream], 'acc-1');
    expect(hit?.account).toBe(dup);
    expect(hit?.entry.connection.id).toBe('c0');
  });
});

describe('unmatchedLinkHint', () => {
  test('an unreadable account list asks for a sync', () => {
    expect(unmatchedLinkHint([entry('c1', []), entry('c2', null)])).toBe('Bank account list unavailable — Sync now to refresh.');
  });

  test('otherwise (or with no data) the link is stale', () => {
    const stale = 'This link no longer matches a bank account — change the link to pick a new one.';
    expect(unmatchedLinkHint([entry('c1', [])])).toBe(stale);
    expect(unmatchedLinkHint([])).toBe(stale);
    expect(unmatchedLinkHint(undefined)).toBe(stale);
  });
});

describe('connectedToLabel', () => {
  test("the account's institution wins, then the connection's, then 'bank'", () => {
    expect(connectedToLabel('Nubank', 'Itaú')).toBe('Connected to Nubank');
    expect(connectedToLabel(null, 'Itaú')).toBe('Connected to Itaú');
    expect(connectedToLabel(null, null)).toBe('Connected to bank');
    // An empty string is not nullish: it is kept as-is.
    expect(connectedToLabel('', 'Itaú')).toBe('Connected to ');
  });
});
