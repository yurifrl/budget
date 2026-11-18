import { describe, expect, it } from 'bun:test';

import { decideRevision } from './revision';

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
