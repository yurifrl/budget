import { describe, expect, test } from 'bun:test';

import {
  accountMatchesPerson,
  budgetForPerson,
  personAccountsLabel,
  checkInvite,
  checkLinkEmail,
  personStatus,
  activityFor,
  anyPersonAssigned,
  categoriesForPerson,
  distinctOwners,
  isSharedInPersonView,
  memberOwnsNoCategories,
  monthTotalsForPerson,
  personActivity,
  personFilterScopeLabel,
  rollupForPerson,
  showPersonRow,
  personFor,
  personFirstName,
  personLabel,
  personFilterLabel,
  type Person,
  sumActivityFor,
  toAvatarPerson,
  transactionsForPerson,
  withMyProfile,
} from './people';
import type { Account, Budget, Category, Transaction } from './types';
import { computeBudgetMonth, categoryFigures } from './zeroSum';
import { payId, scenario } from './zeroSum.fixtures';

const mk = (user_id: string, email: string | null, name: string | null, extra: Partial<Person> = {}): Person => ({
  user_id,
  email,
  name,
  avatar: { seed: user_id, image_version: null },
  is_owner: false,
  is_me: false,
  pending: false,
  ...extra,
});
const ana = mk('u1', 'ana.silva@home.test', 'Ana Maria Silva');
const bob = mk('u2', 'bob@home.test', 'bob', { is_me: true });
const anon = mk('u3', 'zed@home.test', null, { pending: true });

describe('personLabel', () => {
  test('name when set, else email', () => {
    expect(personLabel(ana)).toBe('Ana Maria Silva');
    expect(personLabel(anon)).toBe('zed@home.test');
    expect(personLabel({ email: 'x@y.z', name: '   ' })).toBe('x@y.z');
  });
});

describe('placeholder people (no email)', () => {
  const gab = mk('u9', null, 'Gabriele', { pending: true });
  test('labels fall back to the name, never the (absent) email', () => {
    expect(personLabel(gab)).toBe('Gabriele');
    expect(personFirstName(gab)).toBe('Gabriele');
    expect(personLabel({ email: null, name: null })).toBe('Unnamed');
    expect(personFirstName({ email: null, name: ' ' })).toBe('Unnamed');
    expect(toAvatarPerson(gab)).toMatchObject({ id: 'u9', name: 'Gabriele', email: null });
  });
  test('personStatus: placeholder / invited / signed in', () => {
    expect(personStatus(gab)).toBe('placeholder');
    expect(personStatus(anon)).toBe('invited');
    expect(personStatus(ana)).toBeNull();
  });
  test('checkInvite accepts a name alone, requires one without an email, skips null-email duplicates', () => {
    expect(checkInvite('', '  Gabriele ', [gab])).toEqual({ ok: true, email: undefined, name: 'Gabriele' });
    expect(checkInvite('', '', [gab])).toMatchObject({ ok: false });
    expect(checkInvite('a@b.co', '', [gab])).toMatchObject({ ok: true });
  });
  test('checkLinkEmail normalizes and validates', () => {
    expect(checkLinkEmail(' G@Home.Test ')).toEqual({ ok: true, email: 'g@home.test' });
    expect(checkLinkEmail('')).toMatchObject({ ok: false });
    expect(checkLinkEmail('nope')).toMatchObject({ ok: false });
  });
  test('the viewer and placeholders are all assignable: personFor resolves both', () => {
    expect(personFor([bob, gab], bob.user_id)).toBe(bob);
    expect(personFor([bob, gab], gab.user_id)).toBe(gab);
  });
});

describe('personFirstName', () => {
  test('first word of the name; with no name the email local part', () => {
    expect(personFirstName(ana)).toBe('Ana');
    expect(personFirstName(anon)).toBe('zed');
  });
});

describe('toAvatarPerson', () => {
  test('maps a member to the Avatar person (id, avatar, label, email)', () => {
    expect(toAvatarPerson(ana)).toEqual({
      id: 'u1',
      avatar: { seed: 'u1', image_version: null },
      name: 'Ana Maria Silva',
      email: 'ana.silva@home.test',
    });
    expect(toAvatarPerson(anon).name).toBe('zed@home.test');
  });
});

describe('withMyProfile', () => {
  test('overlays the live profile onto my row only', () => {
    const me = { name: 'Bobby', avatar: { seed: 'fresh', image_version: 3 } };
    const out = withMyProfile([ana, bob], me);
    expect(out[0]).toBe(ana);
    expect(out[1]).toMatchObject({ user_id: 'u2', name: 'Bobby', avatar: me.avatar });
  });
  test('without a loaded profile the members are unchanged', () => {
    expect(withMyProfile([ana, bob], undefined)).toEqual([ana, bob]);
  });
});

describe('checkInvite', () => {
  const people = [ana, bob];
  test('normalizes email and trims the optional name', () => {
    expect(checkInvite('  New@Home.Test ', '  Nia ', people)).toEqual({ ok: true, email: 'new@home.test', name: 'Nia' });
    expect(checkInvite('new@home.test', '   ', people)).toEqual({ ok: true, email: 'new@home.test', name: undefined });
  });
  test('rejects empty, malformed, too-long-name and duplicate (any case)', () => {
    expect(checkInvite('', '', people)).toMatchObject({ ok: false });
    expect(checkInvite('nope', '', people)).toMatchObject({ ok: false });
    expect(checkInvite('a@b.co', 'x'.repeat(81), people)).toMatchObject({ ok: false });
    const dup = checkInvite('ANA.SILVA@home.test', '', people);
    expect(dup).toEqual({ ok: false, error: 'Ana Maria Silva is already in this budget' });
  });
});

describe('personFor', () => {
  const people = [ana, bob];
  test('null and unknown ids are Shared (null)', () => {
    expect(personFor(people, null)).toBeNull();
    expect(personFor(people, 'nope')).toBeNull();
  });
  test('resolves a member', () => {
    expect(personFor(people, 'u2')).toBe(bob);
  });
});

// ---- Plan "by person" filter ------------------------------------------------

const M = 202606;
const acct = (id: string, userId: string | null): Account => ({
  id,
  name: id,
  type: 'checking',
  group: 'CASH',
  onBudget: true,
  clearedBalance: 0,
  unclearedBalance: 0,
  lastReconciledAt: null,
  userId,
});
const txn = (id: string, accountId: string, categoryId: string | null, outflow: number, extra: Partial<Transaction> = {}): Transaction => ({
  id,
  accountId,
  date: '2026-06-05',
  payee: 'p',
  categoryId,
  memo: '',
  outflow,
  inflow: 0,
  cleared: 'cleared',
  approved: true,
  repeat: 'never',
  repeatRuleId: null,
  upcoming: false,
  ...extra,
});
const category = (id: string, activity: Category['activity'] = {}): Category =>
  ({ id, groupId: 'g', name: id, assigned: {}, activity }) as unknown as Category;

function fixture(): Budget {
  const transactions = [
    txn('t1', 'a-ana', 'groceries', 1000),
    txn('t2', 'a-bob', 'groceries', 200),
    txn('t3', 'a-shared', 'groceries', 30),
    txn('t4', 'a-bob', 'fun', 500),
    txn('t5', 'a-ana', 'groceries', 9999, { upcoming: true }),
    txn('t6', 'a-ana', null, 0, {
      splits: [
        { id: 's1', categoryId: 'groceries', memo: '', outflow: 40, inflow: 0 },
        { id: 's2', categoryId: 'fun', memo: '', outflow: 60, inflow: 0 },
      ],
    }),
  ];
  const b = {
    id: 'b',
    accounts: [acct('a-ana', 'u1'), acct('a-bob', 'u2'), acct('a-shared', null)],
    transactions,
  } as unknown as Budget;
  return b;
}

describe('accountMatchesPerson', () => {
  test('all matches everything; shared matches null; id matches that member', () => {
    expect(accountMatchesPerson(acct('x', 'u1'), 'all')).toBe(true);
    expect(accountMatchesPerson(acct('x', null), 'all')).toBe(true);
    expect(accountMatchesPerson(acct('x', null), 'shared')).toBe(true);
    expect(accountMatchesPerson(acct('x', 'u1'), 'shared')).toBe(false);
    expect(accountMatchesPerson(acct('x', 'u1'), 'u1')).toBe(true);
    expect(accountMatchesPerson(acct('x', 'u2'), 'u1')).toBe(false);
    expect(accountMatchesPerson(acct('x', null), 'u1')).toBe(false);
  });
});

describe('transactionsForPerson', () => {
  test('all returns every transaction', () => {
    const b = fixture();
    expect(transactionsForPerson(b, 'all')).toEqual(b.transactions);
  });
  test('shared and person select by the account the transaction is on', () => {
    const b = fixture();
    expect(transactionsForPerson(b, 'shared').map((t) => t.id)).toEqual(['t3']);
    expect(transactionsForPerson(b, 'u2').map((t) => t.id)).toEqual(['t2', 't4']);
    expect(transactionsForPerson(b, 'u1').map((t) => t.id)).toEqual(['t1', 't5', 't6']);
  });
});

/**
 * The same ledger as `fixture()` as a real engine budget: Ana / Bob / Shared
 * checking accounts and two categories (groceries, fun). Household engine
 * activity: groceries -1000 -200 -30 -40, fun -500 -60.
 */
function engineFixture(): Budget {
  const b = scenario({ cash: ['a-ana', 'a-bob', 'a-shared'], categories: ['groceries', 'fun'] })
    .spend('a-ana', 'groceries', 1000, '2026-06-05')
    .spend('a-bob', 'groceries', 200, '2026-06-05')
    .spend('a-shared', 'groceries', 30, '2026-06-05')
    .spend('a-bob', 'fun', 500, '2026-06-05')
    .spend('a-ana', 'groceries', 9999, '2026-06-05', { upcoming: true })
    .split('a-ana', [{ categoryId: 'groceries', cents: -40 }, { categoryId: 'fun', cents: -60 }], '2026-06-05')
    .build();
  const owners: Record<string, string | null> = { 'a-ana': 'u1', 'a-bob': 'u2', 'a-shared': null };
  for (const a of b.accounts) a.userId = owners[a.id];
  return b;
}

describe('personActivity / activityFor', () => {
  const b = engineFixture();
  const bm = computeBudgetMonth(b, M);
  test("'all' is null and activityFor falls back to the engine's household value", () => {
    expect(personActivity(b, 'all')).toBeNull();
    expect(activityFor(bm, 'groceries', null)).toBe(-1270);
    expect(activityFor(bm, 'fun', null)).toBe(-560);
    expect(activityFor(bm, 'unknown', null)).toBe(0);
  });
  test('per-person activity, split legs counted, upcoming excluded', () => {
    const ana = personActivity(b, 'u1')!;
    expect(activityFor(bm, 'groceries', ana)).toBe(-1040); // 1000 + split leg 40; upcoming skipped
    expect(activityFor(bm, 'fun', ana)).toBe(-60);
    const shared = personActivity(b, 'shared')!;
    expect(activityFor(bm, 'groceries', shared)).toBe(-30);
  });
  test('a category with activity only on another person\'s account is 0', () => {
    expect(activityFor(bm, 'fun', personActivity(b, 'shared'))).toBe(0);
    expect(activityFor(bm, 'fun', personActivity(b, 'u2'))).toBe(-500);
  });
  test('person slices partition the household engine activity', () => {
    for (const id of ['groceries', 'fun']) {
      const parts = ['u1', 'u2', 'shared'].map((p) => activityFor(bm, id, personActivity(b, p)));
      expect(parts.reduce((a, c) => a + c, 0)).toBe(categoryFigures(bm, id).activity);
    }
  });
  test('sumActivityFor adds across categories', () => {
    const cs = [category('groceries'), category('fun')];
    expect(sumActivityFor(bm, cs, personActivity(b, 'u2'))).toBe(-700);
    expect(sumActivityFor(bm, cs, null)).toBe(-1830);
  });
  test('a card payment category has no per-person split: it keeps the household figure', () => {
    // 100 funded on the card (rent), 40 paid from Ana's checking: activity 60.
    const card = scenario({ cash: ['a-ana'], cards: ['Card'], categories: ['rent'] })
      .startingBalance('a-ana', 100000, '2026-05-01')
      .assign('rent', M, 500)
      .spend('Card', 'rent', 100, '2026-06-05')
      .transfer('a-ana', 'Card', 40, '2026-06-06')
      .build();
    card.accounts.find((a) => a.id === 'a-ana')!.userId = 'u1';
    const cardBm = computeBudgetMonth(card, M);
    expect(activityFor(cardBm, payId('Card'), personActivity(card, 'u1'))).toBe(60);
    expect(activityFor(cardBm, payId('Card'), personActivity(card, 'u2'))).toBe(60);
  });
});

describe('personFilterLabel', () => {
  test('null for all; Shared; member label; fallback for a removed member', () => {
    expect(personFilterLabel([ana], 'all')).toBeNull();
    expect(personFilterLabel([ana], 'shared')).toBe('Shared');
    expect(personFilterLabel([ana], 'u1')).toBe('Ana Maria Silva');
    expect(personFilterLabel([ana], 'gone')).toBe('Former member');
  });
});

// ---- Category ownership -------------------------------------------------------

const owned = (id: string, userId: string | null, assigned: number, activity = 0): Category =>
  ({ id, groupId: 'g', name: id, userId, assigned: { [M]: assigned }, activity: { [M]: activity } }) as unknown as Category;
const cats = [
  owned('rent', 'u1', 1000, -300),
  owned('fun', 'u2', 500, -100),
  owned('food', null, 200, -50),
  owned('legacy', undefined as unknown as null, 100, 0),
];

describe('categoriesForPerson', () => {
  test('Everyone is exactly all categories, in order', () => {
    expect(categoriesForPerson(cats, 'all').map((c) => c.id)).toEqual(['rent', 'fun', 'food', 'legacy']);
  });
  test('a member sees their own plus Shared (absent userId counts as Shared)', () => {
    expect(categoriesForPerson(cats, 'u1').map((c) => c.id)).toEqual(['rent', 'food', 'legacy']);
    expect(categoriesForPerson(cats, 'u2').map((c) => c.id)).toEqual(['fun', 'food', 'legacy']);
  });
  test('Shared shows only Shared categories', () => {
    expect(categoriesForPerson(cats, 'shared').map((c) => c.id)).toEqual(['food', 'legacy']);
  });
  test('a former member (unknown id) falls back to Shared only', () => {
    expect(categoriesForPerson(cats, 'gone').map((c) => c.id)).toEqual(['food', 'legacy']);
  });
});

describe('category ownership helpers', () => {
  test('isSharedInPersonView only dims Shared rows under a member', () => {
    expect(isSharedInPersonView(cats[2], 'u1')).toBe(true);
    expect(isSharedInPersonView(cats[0], 'u1')).toBe(false);
    expect(isSharedInPersonView(cats[2], 'shared')).toBe(false);
    expect(isSharedInPersonView(cats[2], 'all')).toBe(false);
  });
  test('memberOwnsNoCategories drives the empty-state hint (members only)', () => {
    expect(memberOwnsNoCategories(cats, 'u3')).toBe(true);
    expect(memberOwnsNoCategories(cats, 'u1')).toBe(false);
    expect(memberOwnsNoCategories(cats, 'shared')).toBe(false);
    expect(memberOwnsNoCategories(cats, 'all')).toBe(false);
  });
  test('distinctOwners lists each owner once, Shared excluded', () => {
    expect(distinctOwners([...cats, owned('x', 'u1', 0)])).toEqual(['u1', 'u2']);
    expect(distinctOwners([cats[2]])).toEqual([]);
  });
  test('showPersonRow: others present, or any person assigned; solo + nothing assigned hides', () => {
    const solo = [bob];
    expect(showPersonRow([ana, bob], [], [])).toBe(true);
    expect(showPersonRow(solo, [acct('a', null)], [cats[2]])).toBe(false);
    expect(showPersonRow(solo, [acct('a', 'u2')], [cats[2]])).toBe(true);
    expect(showPersonRow(solo, [], [cats[1]])).toBe(true);
    expect(anyPersonAssigned([], [cats[2]])).toBe(false);
  });
});

describe('monthTotalsForPerson / rollupForPerson', () => {
  // The old `cats` ledger as real transactions: rent 1000/-300, fun 500/-100,
  // food 200/-50, legacy 100/0 (no carryover, no overspend: Available = sum).
  const totalsBudget = (): Budget => {
    const b = scenario({ cash: ['Checking'], categories: ['rent', 'fun', 'food', 'legacy'] })
      .startingBalance('Checking', 1_000_000, '2026-05-01')
      .assign('rent', M, 1000)
      .assign('fun', M, 500)
      .assign('food', M, 200)
      .assign('legacy', M, 100)
      .spend('Checking', 'rent', 300, '2026-06-05')
      .spend('Checking', 'fun', 100, '2026-06-05')
      .spend('Checking', 'food', 50, '2026-06-05')
      .build();
    const owners: Record<string, string | null | undefined> = { rent: 'u1', fun: 'u2', food: null, legacy: undefined };
    for (const c of b.categories) c.userId = owners[c.id] as string | null;
    return b;
  };
  const b = totalsBudget();
  const bm = computeBudgetMonth(b, M);
  const map = { rent: { [M]: -111 }, fun: { [M]: -7 } };
  test('Everyone: household sums from the engine', () => {
    expect(monthTotalsForPerson(bm, b.categories, 'all', null)).toEqual({ assigned: 1800, activity: -450, available: 1800 - 450 });
  });
  test('a member: Assigned/Available over visible categories, Activity the person\'s', () => {
    const t = monthTotalsForPerson(bm, b.categories, 'u1', map);
    expect(t.assigned).toBe(1000 + 200 + 100);
    expect(t.available).toBe(1000 - 300 + (200 - 50) + 100);
    expect(t.activity).toBe(-111 - 7);
  });
  test('Shared: only Shared categories sum', () => {
    expect(monthTotalsForPerson(bm, b.categories, 'shared', {}).assigned).toBe(300);
  });
  test('group rollup sums just the visible rows', () => {
    expect(rollupForPerson(bm, b.categories, 'u2', map).assigned).toBe(500 + 200 + 100);
  });
  test('payment categories count in the totals (unified figures)', () => {
    // 50 spent on the card in rent: funded 50; 300 assigned to the payment category; 20 paid.
    const withCard = scenario({ cash: ['Checking'], cards: ['Card'], categories: ['rent'] })
      .startingBalance('Checking', 1_000_000, '2026-05-01')
      .assign('rent', M, 1000)
      .assign(payId('Card'), M, 300)
      .spend('Card', 'rent', 50, '2026-06-05')
      .transfer('Checking', 'Card', 20, '2026-06-06')
      .build();
    const cardBm = computeBudgetMonth(withCard, M);
    // rent: 1000 - 50 = 950. payment: 300 + 50 - 20 = 330. activity: -50 + (50 - 20).
    expect(monthTotalsForPerson(cardBm, withCard.categories, 'all', null)).toEqual({
      assigned: 1300,
      activity: -50 + 30,
      available: 950 + 330,
    });
  });
});

describe('personFilterScopeLabel', () => {
  test('null for Everyone, "<First>’s categories" for a member, Shared otherwise', () => {
    expect(personFilterScopeLabel([ana, bob], 'all')).toBeNull();
    expect(personFilterScopeLabel([ana, bob], 'u1')).toBe('Ana’s categories');
    expect(personFilterScopeLabel([ana, bob], 'shared')).toBe('Shared categories');
    expect(personFilterScopeLabel([ana, bob], 'gone')).toBe('Shared categories');
  });
});

describe('budgetForPerson / personAccountsLabel', () => {
  const acct = (id: string, userId: string | null) => ({ id, userId }) as Account;
  const txn = (id: string, accountId: string, outflow: number) =>
    ({ id, accountId, outflow, inflow: 0, categoryId: 'c1' }) as Transaction;
  const b = {
    accounts: [acct('a1', 'u1'), acct('a2', null), acct('a3', 'u2')],
    transactions: [txn('t1', 'a1', 100), txn('t2', 'a2', 50), txn('t3', 'a3', 7), txn('t4', 'a1', 1)],
    categories: [{ id: 'c1' } as Category],
  } as unknown as Budget;
  test("'all' is the identity (same object)", () => {
    expect(budgetForPerson(b, 'all')).toBe(b);
  });
  test('a member narrows accounts and transactions to theirs; categories untouched', () => {
    const n = budgetForPerson(b, 'u1');
    expect(n.accounts.map((a) => a.id)).toEqual(['a1']);
    expect(n.transactions.map((t) => t.id)).toEqual(['t1', 't4']);
    expect(n.categories).toBe(b.categories);
  });
  test('shared narrows to accounts with no person; an unknown member to nothing', () => {
    expect(budgetForPerson(b, 'shared').transactions.map((t) => t.id)).toEqual(['t2']);
    expect(budgetForPerson(b, 'gone').transactions).toEqual([]);
  });
  test('account scope labels', () => {
    expect(personAccountsLabel([ana], 'all')).toBeNull();
    expect(personAccountsLabel([ana], 'shared')).toBe('Shared accounts');
    expect(personAccountsLabel([ana], 'u1')).toBe('Ana’s accounts');
    expect(personAccountsLabel([ana], 'gone')).toBe('Shared accounts');
  });
});
