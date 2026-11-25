/**
 * F9: the run's progress row is observability. A failure to write it must not
 * fail a prepare activity (the run would otherwise stop for a bookkeeping
 * table that the workflow does not need).
 */
import { expect, mock, test } from 'bun:test';
import type { Pool } from 'pg';

import type { JobContext } from '../jobs';

test('a progress write failure cannot fail prepare', async () => {
  // Capture the real module, then put it back: Bun keeps the module registry
  // shared across test files, so mock.restore() alone is not enough here.
  const actualChunk = await import('./chunk');
  mock.module('./chunk', () => ({
    ...actualChunk,
    prepareRun: async () => ({ total: 3, remaining: 0, snapshot: null }),
  }));
  const { createCategorizeActivities } = await import('./activities');
  const failingDb = {
    query: async () => {
      throw new Error('progress table down');
    },
  } as unknown as Pool;
  const activities = createCategorizeActivities(failingDb, async (_runId, body) =>
    body({ log: async () => undefined } as unknown as JobContext),
  );
  try {
    const result = await activities.categorizePrepare({
      runId: crypto.randomUUID(),
      budgetId: crypto.randomUUID(),
      force: false,
    });
    expect(result).toEqual({ total: 3, remaining: 0, snapshot: null });
  } finally {
    mock.module('./chunk', () => actualChunk);
  }
});
