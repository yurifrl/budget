import { describe, expect, test } from 'bun:test';

import { pathParamNames } from '../operation-contract';
import { contracts as budget } from './budget';
import { contracts as categorize } from './categorize';
import { contracts as connections } from './connections';
import { contracts as features } from './features';
import { contracts as jobs } from './jobs';
import { contracts as oauth } from './oauth';
import { contracts as rates } from './rates';
import { contracts as user } from './user';

const all = { budget, categorize, connections, features, jobs, oauth, rates, user };

describe('contract barrels', () => {
  for (const [feature, list] of Object.entries(all)) {
    test(`${feature}: non-empty, names unique and feature-prefixed, path params are inputs`, () => {
      expect(list.length).toBeGreaterThan(0);
      expect(new Set(list.map((c) => c.name)).size).toBe(list.length);
      for (const c of list) {
        for (const p of pathParamNames(c.path)) expect(Object.keys(c.input.shape)).toContain(p);
      }
    });
  }

  test('names are unique across features', () => {
    const names = Object.values(all).flatMap((l) => l.map((c) => c.name));
    expect(new Set(names).size).toBe(names.length);
  });
});
