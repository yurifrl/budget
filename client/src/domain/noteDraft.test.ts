import { describe, expect, test } from 'bun:test';

import { noteDraft, syncNoteDraft } from './noteDraft';

describe('syncNoteDraft (budget-xd6)', () => {
  test('a changed server value replaces the draft (budget switch / notes loaded)', () => {
    expect(syncNoteDraft(noteDraft('Trabalho note'), 'Casa note')).toEqual({ draft: 'Casa note', saved: 'Casa note' });
    expect(syncNoteDraft(noteDraft(''), 'loaded later')).toEqual({ draft: 'loaded later', saved: 'loaded later' });
  });
  test('an unchanged server value keeps the user typing', () => {
    const typing = { draft: 'half typed', saved: 'x' };
    expect(syncNoteDraft(typing, 'x')).toBe(typing);
  });
});
