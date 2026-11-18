/**
 * Server-side release version.
 *
 * Single source: the api/ `VERSION` file — UTC date `YYYY.MM.DD` (the app
 * release pattern; see `core/version.ts` for the client-side copy of the
 * pattern helpers). Entrypoints read it once and inject it into `buildApp`;
 * features and routes never read the filesystem themselves.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** Release version pattern: `YYYY.MM.DD` with optional `-NN` suffix (matches `core/version.ts`). */
const APP_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(-\d{2})?$/;

const VERSION_FILE = join(import.meta.dir, '..', '..', 'VERSION');

/** Read the release version from the api/ `VERSION` file. Throws when missing or malformed. */
export function readAppVersion(): string {
  const version = readFileSync(VERSION_FILE, 'utf8').trim();
  if (!APP_VERSION_PATTERN.test(version)) {
    throw new Error(`Invalid VERSION file: expected YYYY.MM.DD[-NN], got "${version}"`);
  }
  return version;
}
