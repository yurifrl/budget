import { describe, expect, test } from 'bun:test';

import type { ConnectionUpstreamJson, UpstreamAccountJson } from '../../data/connections';
import type { AccountRow } from '../../data/rows';
import {
  accountOptionGroups,
  linkedSummaryAccounts,
  comparableBankCents,
  matchHint,
  typeMismatchWarning,
  upstreamOptionGroups,
  workingBalanceCents,
} from './linkPicker';

const acct = (over: Partial<AccountRow>): AccountRow =>
  ({
    id: 'a1',
    name: 'Checking',
    type: 'checking',
    closed: false,
    deleted: false,
    cleared_balance: 100000,
    uncleared_balance: 50000,
    connection_id: null,
    external_account_id: null,
    institution: null,
    ...over,
  }) as AccountRow;

const up = (over: Partial<UpstreamAccountJson>): UpstreamAccountJson => ({
  externalId: 'x1',
  name: 'Conta',
  type: 'BANK',
  currencyCode: 'BRL',
  balanceCents: 15000,
  institution: 'Itau',
  linkedAccountId: null,
  ...over,
});

const conn = (id: string, accounts: UpstreamAccountJson[] | null): ConnectionUpstreamJson =>
  ({ connection: { id, institution: 'Itau', provider: 'pluggy' }, accounts }) as ConnectionUpstreamJson;

describe('linkPicker domain', () => {
  test('working balance sums cleared and uncleared milliunits to cents', () => {
    expect(workingBalanceCents(acct({}))).toBe(15000);
  });

  test('match hint: equal, different, unknown', () => {
    expect(matchHint(15000, 15000)).toEqual({ kind: 'match' });
    expect(matchHint(15000, 14000)).toEqual({ kind: 'diff', diffCents: 1000 });
    expect(matchHint(15000, null)).toBeNull();
  });

  test('credit figure is negative used, then negative bill, else null', () => {
    const base = { type: 'CREDIT' as const, balanceCents: 0 };
    expect(comparableBankCents({ ...base, credit: { limitCents: 9000, availableCents: null, usedCents: 4000, minimumPaymentCents: null, dueDate: null, latestBill: { totalCents: 3000, dueDate: null, minimumPaymentCents: null } } })).toBe(-4000);
    expect(comparableBankCents({ ...base, credit: { limitCents: null, availableCents: null, usedCents: null, minimumPaymentCents: null, dueDate: null, latestBill: { totalCents: 3000, dueDate: null, minimumPaymentCents: null } } })).toBe(-3000);
    expect(comparableBankCents({ ...base, credit: null })).toBeNull();
    expect(comparableBankCents({ type: 'BANK', balanceCents: 5, credit: null })).toBe(5);
  });

  test('type mismatch warns only on clear clashes', () => {
    expect(typeMismatchWarning('checking', 'CREDIT')).not.toBeNull();
    expect(typeMismatchWarning('creditCard', 'BANK')).not.toBeNull();
    expect(typeMismatchWarning('creditCard', 'CREDIT')).toBeNull();
    expect(typeMismatchWarning('mortgage', 'BANK')).toBeNull();
  });

  test('upstream groups: keeps order, disables other links, flags failed providers', () => {
    const target = acct({ id: 'a1' });
    const other = acct({ id: 'a2', name: 'Savings' });
    const groups = upstreamOptionGroups(
      [conn('c1', [up({ externalId: 'x1', balanceCents: 15000 }), up({ externalId: 'x2', name: 'Poup', linkedAccountId: 'a2' }), up({ externalId: 'x3', linkedAccountId: 'a1' })]), conn('c2', null)],
      target,
      [target, other],
    );
    expect(groups[0].options.map((o) => o.id)).toEqual(['c1:x1', 'c1:x2', 'c1:x3']);
    expect(groups[0].options[0].hint).toEqual({ kind: 'match' });
    expect(groups[0].options[1].linkedTo).toBe('Savings');
    // already linked to the target itself is selectable (current link)
    expect(groups[0].options[2].linkedTo).toBeNull();
    expect(groups[1].unavailable).toContain('Could not load accounts from Itau');
  });

  test('account groups: exclude closed, disable linked, hint against bank figure', () => {
    const bank = up({ balanceCents: 15000 });
    const groups = accountOptionGroups(
      bank,
      [acct({ id: 'a1' }), acct({ id: 'a2', closed: true }), acct({ id: 'a3', name: 'Other', connection_id: 'c9' })],
      [conn('c9', [up({ externalId: 'x9', name: 'Other bank acct', linkedAccountId: 'a3' })])],
    );
    const opts = groups[0].options;
    expect(opts.map((o) => o.id)).toEqual(['a1', 'a3']);
    expect(opts[0].hint).toEqual({ kind: 'match' });
    expect(opts[1].linkedTo).toBe('Other bank acct');
  });

  test('linked accounts missing from the summary are synthesized with zero counts', () => {
    const a1 = acct({ id: 'a1' });
    const out = linkedSummaryAccounts([], [up({ externalId: 'x1', linkedAccountId: 'a1' }), up({ externalId: 'x2' })], [a1]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ accountId: 'a1', externalAccountId: 'x1', totalCount: 0, balance: 150000 });
    expect(linkedSummaryAccounts(out, [up({ externalId: 'x1', linkedAccountId: 'a1' })], [a1])).toHaveLength(1);
  });
});
