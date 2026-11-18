import { expect, test } from 'bun:test';
import path from 'node:path';

import { bundleWorkflowCode } from '@temporalio/worker';

test('bundleWorkflowCode builds the workflow bundle', async () => {
  const { code } = await bundleWorkflowCode({
    workflowsPath: path.resolve(import.meta.dir, 'index.ts'),
    logger: { trace() {}, debug() {}, info() {}, warn() {}, error() {}, log() {} } as never,
  });
  expect(code.length).toBeGreaterThan(1000);
  expect(code).toContain('helloWorkflow');
}, 120_000);
