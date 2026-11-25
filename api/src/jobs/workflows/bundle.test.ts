import { expect, test } from 'bun:test';
import path from 'node:path';

import { bundleWorkflowCode } from '@temporalio/worker';

// Phase 0 spike, folded into the real thing: the production workflow entry
// (jobs/workflows/index.ts, re-exporting connections' pure workflows.ts) must
// bundle in Temporal's sandbox, i.e. import nothing but @temporalio/workflow.
test('bundleWorkflowCode builds the real workflow bundle', async () => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: path.resolve(import.meta.dir, 'index.ts'),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} } as never,
  });
  expect(code.length).toBeGreaterThan(1000);
  for (const name of ['jobsNoop', 'jobsRetention', 'connectionsSync', 'connectionsSweep', 'categorizeRun']) {
    expect(code).toContain(name);
  }
}, 120_000);
