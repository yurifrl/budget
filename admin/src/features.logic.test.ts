/// <reference types="bun" />
import { expect, test } from 'bun:test';

import type { AdminFeature, FeatureValue } from '@shared/contracts/features';

import {
  changedLabel,
  everyoneState,
  featureKeyFromPath,
  groupFeatures,
  matchesFeature,
  overridesLabel,
  popoverPlacement,
  shownLabel,
  userState,
  userSummary,
} from './features.logic';

const now = Date.parse('2026-11-20T12:00:00Z');
const ANN = 'ann-id';
const BOB = 'bob-id';
const by = (value: boolean, minutesAgo = 5): FeatureValue => ({
  value,
  changed_by: { id: 'admin-id', email: 'admin@x.test', name: 'Admin' },
  changed_at: new Date(now - minutesAgo * 60_000).toISOString(),
});
const feature = (over: Partial<AdminFeature> = {}): AdminFeature => ({
  key: 'shared-pluggy-key',
  group: 'Banks',
  description: 'd',
  default: false,
  everyone: null,
  overrides: [],
  ...over,
});

test('everyoneState: nothing stored shows the default; a stored value wins', () => {
  expect(everyoneState(feature())).toEqual({ value: false, source: 'default', stored: null, label: 'not set: the default (off) applies' });
  expect(everyoneState(feature({ default: true }))).toMatchObject({ value: true, source: 'default' });
  const on = by(true);
  expect(everyoneState(feature({ everyone: on }))).toEqual({ value: true, source: 'everyone', stored: on, label: 'set for everyone: on' });
  expect(everyoneState(feature({ default: true, everyone: by(false) }))).toMatchObject({ value: false, label: 'set for everyone: off' });
});

test('userState: override, else the everyone value, else the default', () => {
  expect(userState(feature(), ANN)).toEqual({ value: false, source: 'default', stored: null, label: 'inherited: default is off' });
  expect(userState(feature({ everyone: by(true) }), ANN)).toEqual({ value: true, source: 'everyone', stored: null, label: 'inherited: everyone is on' });
  const override = { ...by(false), user_id: ANN };
  const f = feature({ everyone: by(true), overrides: [override] });
  expect(userState(f, ANN)).toEqual({ value: false, source: 'user', stored: override, label: 'overridden' });
  expect(userState(f, BOB)).toMatchObject({ value: true, source: 'everyone' });
  // An override equal to the inherited value is still an override.
  expect(userState(feature({ overrides: [{ ...by(false), user_id: ANN }] }), ANN)).toMatchObject({ value: false, source: 'user', label: 'overridden' });
});

test('changedLabel: who and when, also when the admin is gone', () => {
  expect(changedLabel(null, now)).toBe('');
  expect(changedLabel(by(true, 5), now)).toBe('by admin@x.test, 5 minutes ago');
  expect(changedLabel({ ...by(true, 180), changed_by: null }, now)).toBe('by a deleted user, 3 hours ago');
  expect(changedLabel({ ...by(true, 0), changed_by: { id: 'p', email: null, name: 'Pat' } }, now)).toBe('by Pat, just now');
});

test('userSummary counts what is on and what is overridden, out of all features', () => {
  const second = feature({ key: 'second', default: true });
  expect(userSummary([feature(), second], ANN)).toEqual({ on: 1, overridden: 0, label: '1 of 2 on' });
  const f = feature({ overrides: [{ ...by(true), user_id: ANN }] });
  expect(userSummary([f, second], ANN)).toEqual({ on: 2, overridden: 1, label: '2 of 2 on, 1 overridden' });
  expect(userSummary([], ANN).label).toBe('0 of 0 on');
});

const MANY = [
  feature({ key: 'shared-pluggy-key', group: 'Banks', description: 'Shared Pluggy keys.' }),
  feature({ key: 'plan-auto-assign', group: 'Plan', description: 'Auto-assign button on the plan.' }),
  feature({ key: 'bank-reimport', group: 'Banks', description: 'Re-import a bank connection.' }),
  feature({ key: 'csv-import', group: 'Import', description: 'Import a CSV file from a bank.' }),
  feature({ key: 'plan-bundles', group: 'Plan', description: 'Category bundles.' }),
];
const shape = (q?: string) => groupFeatures(MANY, q).map((g) => [g.group, g.features.map((f) => f.key)]);

test('groupFeatures: groups in the order the list first names them, features in list order', () => {
  expect(shape()).toEqual([
    ['Banks', ['shared-pluggy-key', 'bank-reimport']],
    ['Plan', ['plan-auto-assign', 'plan-bundles']],
    ['Import', ['csv-import']],
  ]);
  expect(groupFeatures([])).toEqual([]);
});

test('groupFeatures filters by key, group or description and drops empty groups', () => {
  expect(shape('pluggy')).toEqual([['Banks', ['shared-pluggy-key']]]);
  expect(shape('  PLAN ')).toEqual([['Plan', ['plan-auto-assign', 'plan-bundles']]]);
  // "bank" is a group name, part of a key and a word in a description.
  expect(shape('bank')).toEqual([
    ['Banks', ['shared-pluggy-key', 'bank-reimport']],
    ['Import', ['csv-import']],
  ]);
  // Every word must match.
  expect(shape('plan bundles')).toEqual([['Plan', ['plan-bundles']]]);
  expect(shape('nothing-like-this')).toEqual([]);
});

test('matchesFeature, shownLabel, overridesLabel', () => {
  expect(matchesFeature(MANY[0]!, '')).toBe(true);
  expect(matchesFeature(MANY[0]!, 'banks shared')).toBe(true);
  expect(matchesFeature(MANY[0]!, 'plan')).toBe(false);
  expect(shownLabel(5, 5, '')).toBe('5 features');
  expect(shownLabel(1, 1, ' ')).toBe('1 feature');
  expect(shownLabel(2, 5, 'bank')).toBe('2 of 5 shown');
  expect(overridesLabel(feature())).toBe('no overrides');
  expect(overridesLabel(feature({ overrides: [{ ...by(true), user_id: ANN }] }))).toBe('1 user overridden');
  expect(overridesLabel(feature({ overrides: [{ ...by(true), user_id: ANN }, { ...by(false), user_id: BOB }] }))).toBe('2 users overridden');
});

test('featureKeyFromPath: the key of a detail path, null on the list', () => {
  expect(featureKeyFromPath('/features')).toBeNull();
  expect(featureKeyFromPath('/features/')).toBeNull();
  expect(featureKeyFromPath('/features/b-c')).toBe('b-c');
  expect(featureKeyFromPath('/features/a%20b')).toBe('a b');
  expect(featureKeyFromPath('/users')).toBeNull();
});

test('popoverPlacement: right-aligned under the button, inside the viewport, above when there is no room below', () => {
  const vp = { width: 1280, height: 800 };
  expect(popoverPlacement({ top: 100, bottom: 130, left: 900, right: 1100 }, vp)).toEqual({ left: 480, width: 620, top: 134, maxHeight: 520 });
  // Near the left edge: pushed in, not off-screen.
  expect(popoverPlacement({ top: 100, bottom: 130, left: 10, right: 200 }, vp).left).toBe(8);
  // Some room below: stays below, shorter.
  expect(popoverPlacement({ top: 400, bottom: 430, left: 900, right: 1100 }, vp)).toMatchObject({ top: 434, maxHeight: 358 });
  // Near the bottom: opens upward.
  expect(popoverPlacement({ top: 700, bottom: 730, left: 900, right: 1100 }, vp)).toEqual({ left: 480, width: 620, bottom: 104, maxHeight: 520 });
  // A narrow window: as wide as fits.
  expect(popoverPlacement({ top: 100, bottom: 130, left: 100, right: 300 }, { width: 400, height: 800 })).toMatchObject({ left: 8, width: 384 });
});
