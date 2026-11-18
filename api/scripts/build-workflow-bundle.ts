/**
 * Pre-build the Temporal workflow bundle (run at image build time:
 * `bun run build:workflows`). The worker then loads dist/workflow-bundle.js
 * and never runs webpack at boot. See src/jobs/workflows/source.ts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { bundleWorkflowCode } from '@temporalio/worker';

import { WORKFLOW_BUNDLE_PATH, WORKFLOWS_ENTRY_PATH } from '../src/jobs/workflows/source';

const { code } = await bundleWorkflowCode({ workflowsPath: WORKFLOWS_ENTRY_PATH });
mkdirSync(path.dirname(WORKFLOW_BUNDLE_PATH), { recursive: true });
writeFileSync(WORKFLOW_BUNDLE_PATH, code);
console.log(`workflow bundle: ${WORKFLOW_BUNDLE_PATH} (${(code.length / 1024 / 1024).toFixed(2)} MB)`);
