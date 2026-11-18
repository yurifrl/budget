import { describe, expect, test } from 'bun:test';

import { PERSON_ALL, PERSON_SHARED } from './people';
import { ADD_SENTINEL, buildPlanSections, dropRowOrder, planItemKey, type PlanSectionsInput } from './planSections';
import { budgetOf, cat, group, month } from './__fixtures__/plan.fixtures';

const budget = budgetOf({
  groups: [group('g1'), group('g2'), group('g3')],
  categories: [
    cat('a', 'g1'),
    cat('b', 'g1', { bundleId: 'bu' }),
    cat('c', 'g1', { bundleId: 'bu', userId: 'ana' }),
    cat('h', 'g1', { hidden: true }),
    cat('d', 'g2', { userId: 'ana' }),
  ],
  bundles: [{ id: 'bu', groupId: 'g1', name: 'Bundle' }],
});
const bm = month({ a: { available: 500 }, b: { assigned: 100, activity: -30, available: 70 }, c: { assigned: 5, activity: -2, available: 3 } });

const build = (over: Partial<PlanSectionsInput> = {}) =>
  buildPlanSections({
    budget,
    bm,
    filter: 'all',
    person: PERSON_ALL,
    activity: null,
    collapsed: {},
    expandedBundles: {},
    addCatGroup: null,
    addCatBundle: null,
    ...over,
  });
const keys = (sections: ReturnType<typeof build>) =>
  sections.map((s) => [s.group.id, s.data.map(planItemKey)] as const);

describe('buildPlanSections', () => {
  test('groups in budget order; hidden categories left out; a bundle sits at its first child, collapsed', () => {
    expect(keys(build())).toEqual([
      ['g1', ['a', 'bundle:bu']],
      ['g2', ['d']],
      ['g3', []],
    ]);
  });

  test('a bundle row carries its children and their summed figures', () => {
    const row = build()[0].data[1];
    expect(row).toMatchObject({
      kind: 'bundle',
      bundle: { id: 'bu' },
      sums: { assigned: 105, activity: -32, available: 73 },
    });
    expect((row as { children: { id: string }[] }).children.map((c) => c.id)).toEqual(['b', 'c']);
  });

  test('an expanded bundle lists its children right after it', () => {
    expect(keys(build({ expandedBundles: { bu: true } }))[0][1]).toEqual(['a', 'bundle:bu', 'b', 'c']);
  });

  test('bundle activity uses the per-person map when one is given', () => {
    const row = build({ person: 'ana', activity: { b: { 202606: -7 } } })[0].data[1];
    expect(row).toMatchObject({ sums: { activity: -7 } });
  });

  test('a collapsed group has no rows but keeps its header while it holds categories', () => {
    const out = build({ collapsed: { g1: true, g3: true } });
    expect(keys(out)).toEqual([
      ['g1', []],
      ['g2', ['d']],
    ]);
    expect(out[0].hasCats).toBe(true);
  });

  test('an empty group shows on All + Everyone only while expanded', () => {
    expect(build().map((s) => s.group.id)).toContain('g3');
    expect(build({ collapsed: { g3: true } }).map((s) => s.group.id)).not.toContain('g3');
    expect(build({ filter: 'money-available' }).map((s) => s.group.id)).toEqual(['g1']);
  });

  test('a filter drops non-matching rows and the groups left empty', () => {
    expect(keys(build({ filter: 'money-available' }))).toEqual([['g1', ['a', 'bundle:bu']]]);
    expect(build({ filter: 'snoozed' })).toEqual([]);
  });

  test('a filter with a collapsed group: the header is dropped (only All keeps collapsed headers for Everyone)', () => {
    expect(build({ filter: 'money-available', collapsed: { g1: true } })).toEqual([]);
  });

  test('a member sees their own plus Shared categories; empty groups go away', () => {
    expect(keys(build({ person: 'ana', expandedBundles: { bu: true } }))).toEqual([
      ['g1', ['a', 'bundle:bu', 'b', 'c']],
      ['g2', ['d']],
    ]);
  });

  test('Shared sees only unowned categories; a collapsed group with visible ones keeps its header under any filter', () => {
    expect(keys(build({ person: PERSON_SHARED, expandedBundles: { bu: true } }))).toEqual([['g1', ['a', 'bundle:bu', 'b']]]);
    expect(keys(build({ person: PERSON_SHARED, filter: 'money-available', collapsed: { g1: true } }))).toEqual([['g1', []]]);
  });

  test('the add row goes last in its group, opens a collapsed group and marks an empty one as having rows', () => {
    expect(keys(build({ addCatGroup: 'g1', collapsed: { g1: true } }))[0][1]).toEqual(['a', 'bundle:bu', ADD_SENTINEL]);
    const g3 = build({ addCatGroup: 'g3', filter: 'snoozed' });
    expect(keys(g3)).toEqual([['g3', [ADD_SENTINEL]]]);
    expect(g3[0].hasCats).toBe(true);
  });

  test('"add category here" puts the add row right under its bundle (after the children when expanded)', () => {
    expect(keys(build({ addCatGroup: 'g1', addCatBundle: 'bu' }))[0][1]).toEqual(['a', 'bundle:bu', ADD_SENTINEL]);
    expect(keys(build({ addCatGroup: 'g1', addCatBundle: 'bu', expandedBundles: { bu: true } }))[0][1]).toEqual([
      'a',
      'bundle:bu',
      'b',
      'c',
      ADD_SENTINEL,
    ]);
  });

  test('an add row aimed at a bundle that is not shown adds no row, but the group still counts as having rows', () => {
    const out = build({ addCatGroup: 'g2', addCatBundle: 'bu' });
    expect(keys(out)[1]).toEqual(['g2', ['d']]);
    expect(out[1].hasCats).toBe(true);
  });

  test('a bundle id set without its group adds nothing', () => {
    expect(keys(build({ addCatBundle: 'bu' }))[0][1]).toEqual(['a', 'bundle:bu']);
  });
});

describe('planItemKey / dropRowOrder', () => {
  test('keys: sentinel, bundle:<id>, category id', () => {
    const [g1] = build({ addCatGroup: 'g1', expandedBundles: { bu: true } });
    expect(g1.data.map(planItemKey)).toEqual(['a', 'bundle:bu', 'b', 'c', ADD_SENTINEL]);
  });

  test('drop order spans every section in display order and skips the add row', () => {
    expect(dropRowOrder(build({ addCatGroup: 'g1', expandedBundles: { bu: true } }))).toEqual(['a', 'bundle:bu', 'b', 'c', 'd']);
    expect(dropRowOrder([])).toEqual([]);
  });
});
