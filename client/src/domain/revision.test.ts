import { describe, expect, it } from 'bun:test';

import { BUDGET_DATA_TAGS, decideRevision } from './revision';

describe('decideRevision', () => {
  it('first value only sets the baseline', () => {
    expect(decideRevision(null, 7)).toEqual({ last: 7, invalidate: false });
  });
  it('unchanged does not invalidate', () => {
    expect(decideRevision(7, 7)).toEqual({ last: 7, invalidate: false });
  });
  it('changed invalidates and advances', () => {
    expect(decideRevision(7, 9)).toEqual({ last: 9, invalidate: true });
  });
});

describe('BUDGET_DATA_TAGS', () => {
  it('refreshes the Categorize queue on a revision change', () => {
    expect(BUDGET_DATA_TAGS).toContain('Categorize');
  });
});
