import { describe, expect, test } from 'bun:test';

import {
  budgetCardActions,
  budgetCardCaption,
  budgetEntryRoute,
  checkBudgetName,
  homeGreeting,
  homeSections,
  homeView,
  peopleLabel,
  sharedByLabel,
} from './home.logic';

const avatar = { seed: 's', image_version: null };
const ana = { user_id: 'u-ana', name: 'Ana Lima', email: 'ana@x.test', avatar };
const row = (name: string, over: Partial<{ archived_at: string | null; is_owner: boolean }> = {}) => ({
  name,
  archived_at: null,
  is_owner: true,
  ...over,
});

describe('homeSections', () => {
  test('owned, shared and archived budgets each get their section', () => {
    const s = homeSections([
      row('Home'),
      row('Trip', { is_owner: false }),
      row('Old', { archived_at: '2026-01-01T00:00:00Z' }),
      row('Old shared', { archived_at: '2026-02-01T00:00:00Z', is_owner: false }),
    ]);
    expect(s.mine.map((b) => b.name)).toEqual(['Home']);
    expect(s.shared.map((b) => b.name)).toEqual(['Trip']);
    expect(s.archived.map((b) => b.name)).toEqual(['Old', 'Old shared']);
  });

  test('sorted by name, ignoring case, numbers in order', () => {
    const s = homeSections([row('beta'), row('Budget 10'), row('Alpha'), row('Budget 2')]);
    expect(s.mine.map((b) => b.name)).toEqual(['Alpha', 'beta', 'Budget 2', 'Budget 10']);
  });

  test('no list yet, or an empty one: three empty sections; the input is not reordered', () => {
    expect(homeSections(undefined)).toEqual({ mine: [], shared: [], archived: [] });
    const rows = [row('b'), row('a')];
    homeSections(rows);
    expect(rows.map((r) => r.name)).toEqual(['b', 'a']);
  });
});

describe('homeView', () => {
  test('loading until the list arrives, then empty or list', () => {
    expect(homeView({ data: undefined, isError: false })).toBe('loading');
    expect(homeView({ data: [], isError: false })).toBe('empty');
    expect(homeView({ data: [{}], isError: false })).toBe('list');
  });

  test('an error with nothing loaded is the error state; with a list it keeps showing', () => {
    expect(homeView({ data: undefined, isError: true })).toBe('error');
    expect(homeView({ data: [{}], isError: true })).toBe('list');
    expect(homeView({ data: [], isError: true })).toBe('empty');
  });
});

describe('card copy', () => {
  test('people count, owner included', () => {
    expect(peopleLabel(1)).toBe('Only you');
    expect(peopleLabel(0)).toBe('Only you');
    expect(peopleLabel(3)).toBe('3 people');
  });

  test('who shared it: name, else email, else nobody named', () => {
    expect(sharedByLabel(ana)).toBe('Shared by Ana Lima');
    expect(sharedByLabel({ ...ana, name: '  ' })).toBe('Shared by ana@x.test');
    expect(sharedByLabel(null)).toBe('Shared with you');
  });

  test('caption: mine shows the people, shared shows who shared it and the people', () => {
    expect(budgetCardCaption({ is_owner: true, owner: ana, member_count: 1 })).toBe('Only you');
    expect(budgetCardCaption({ is_owner: true, owner: ana, member_count: 2 })).toBe('2 people');
    expect(budgetCardCaption({ is_owner: false, owner: ana, member_count: 3 })).toBe('Shared by Ana Lima · 3 people');
  });
});

describe('budgetCardActions', () => {
  test('the owner invites, a member sees the people, archived budgets offer neither', () => {
    expect(budgetCardActions({ archived_at: null, is_owner: true })).toEqual({ people: 'Invite' });
    expect(budgetCardActions({ archived_at: null, is_owner: false })).toEqual({ people: 'People' });
    expect(budgetCardActions({ archived_at: '2026-01-01', is_owner: true })).toEqual({ people: null });
  });
});

describe('checkBudgetName', () => {
  test('trims; rejects empty and over-long names', () => {
    expect(checkBudgetName('  Home  ')).toEqual({ ok: true, name: 'Home' });
    expect(checkBudgetName('   ')).toEqual({ ok: false, error: 'Give the budget a name' });
    expect(checkBudgetName('x'.repeat(81)).ok).toBe(false);
    expect(checkBudgetName('x'.repeat(80)).ok).toBe(true);
  });
});

describe('homeGreeting', () => {
  test('first run welcomes by first name when there is one', () => {
    expect(homeGreeting({ name: 'Ana Lima' }, 'empty')).toBe('Welcome, Ana.');
    expect(homeGreeting({ name: null }, 'empty')).toBe('Welcome.');
    expect(homeGreeting(undefined, 'empty')).toBe('Welcome.');
  });

  test('otherwise it names the page', () => {
    expect(homeGreeting({ name: 'Ana' }, 'list')).toBe('Your budgets');
  });
});

describe('budgetEntryRoute', () => {
  test('phone opens on Overview, wider windows on Plan', () => {
    expect(budgetEntryRoute(true)).toBe('/overview');
    expect(budgetEntryRoute(false)).toBe('/plan');
  });
});
