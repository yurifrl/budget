import { expect, test } from 'bun:test';

import { WORKFLOW_BUNDLE_PATH, WORKFLOWS_ENTRY_PATH, workflowSource } from './source';

test('uses the pre-built bundle when it exists', () => {
  expect(workflowSource('/x/bundle.js', () => true)).toEqual({ workflowBundle: { codePath: '/x/bundle.js' } });
});

test('falls back to bundling the workflow entry at start when there is no bundle', () => {
  expect(workflowSource('/x/bundle.js', () => false)).toEqual({ workflowsPath: WORKFLOWS_ENTRY_PATH });
});

test('paths point inside api/', () => {
  expect(WORKFLOW_BUNDLE_PATH.endsWith('/api/dist/workflow-bundle.js')).toBe(true);
  expect(WORKFLOWS_ENTRY_PATH.endsWith('/api/src/jobs/workflows/index.ts')).toBe(true);
});
