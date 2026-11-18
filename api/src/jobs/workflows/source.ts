/**
 * Where the Temporal worker gets its workflow code.
 *
 * In the image the bundle is pre-built at image build time
 * (`bun run build:workflows` -> dist/workflow-bundle.js), so the worker loads a
 * file. Without it (local dev, tests) the SDK bundles `./index.ts` with webpack
 * when the worker starts, which costs a few hundred MB of memory for some
 * seconds: enough to get the pod OOMKilled on every boot.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** api/dist/workflow-bundle.js, written by scripts/build-workflow-bundle.ts. */
export const WORKFLOW_BUNDLE_PATH = fileURLToPath(new URL('../../../dist/workflow-bundle.js', import.meta.url));
/** The workflow entry the bundle is built from. */
export const WORKFLOWS_ENTRY_PATH = fileURLToPath(new URL('./index.ts', import.meta.url));

export type WorkflowSource =
  | { workflowBundle: { codePath: string } }
  | { workflowsPath: string };

export function workflowSource(
  bundlePath: string = WORKFLOW_BUNDLE_PATH,
  exists: (path: string) => boolean = existsSync,
): WorkflowSource {
  return exists(bundlePath) ? { workflowBundle: { codePath: bundlePath } } : { workflowsPath: WORKFLOWS_ENTRY_PATH };
}
