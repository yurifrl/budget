/**
 * CLI entrypoint: reads argv + env, wires the contracts catalog into the cli
 * feature. All command logic is generated in api/src/cli/.
 */
import { contracts } from './catalog';
import { resolveConfigDir, runCli } from './cli/index';

const code = await runCli({
  contracts,
  argv: process.argv.slice(2),
  defaultApiUrl: process.env.BUDGET_API_URL || process.env.API_URL || 'http://localhost:3100',
  configDir: resolveConfigDir(process.env),
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
});
process.exit(code);
