/// <reference types="bun" />
import { expect, test } from 'bun:test';

import type { AdminFeature, FeatureValue } from '@shared/contracts/features';

import { changedLabel, everyoneState, pickFeature, userState, userSummary } from './features.logic';

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

test('userSummary counts what is on and what is overridden', () => {
  const second = feature({ key: 'second', default: true });
  expect(userSummary([feature(), second], ANN)).toEqual({ on: 1, overridden: 0, label: '1 on' });
  const f = feature({ overrides: [{ ...by(true), user_id: ANN }] });
  expect(userSummary([f, second], ANN)).toEqual({ on: 2, overridden: 1, label: '2 on, 1 overridden' });
  expect(userSummary([], ANN).label).toBe('0 on');
});

test('pickFeature: the key in the hash path, else the first feature', () => {
  const list = [{ key: 'a' }, { key: 'b-c' }];
  expect(pickFeature(list, '/features')).toEqual({ key: 'a' });
  expect(pickFeature(list, '/features/b-c')).toEqual({ key: 'b-c' });
  expect(pickFeature(list, '/features/gone')).toEqual({ key: 'a' });
  expect(pickFeature([], '/features/a')).toBeNull();
});
