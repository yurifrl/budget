/**
 * Release bump: move `api/VERSION` to its next release version (today when
 * older, the next same-day `-NN` suffix otherwise, the day after only when the
 * suffix is exhausted). Pattern: `YYYY.MM.DD[-NN]`.
 *
 * Committing and pushing is the caller's job (`task release`): a push of a
 * changed api/VERSION triggers `.github/workflows/version.yml`, which tags it
 * and dispatches `release.yml`.
 *
 * Zero dependencies: `bun scripts/release-bump.ts` runs with nothing installed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(-\d{2})?$/;

export function nextAppVersion(current: string, now: Date = new Date()): string {
  if (!APP_VERSION_PATTERN.test(current)) {
    throw new Error(`VERSION must be YYYY.MM.DD[-NN] (e.g. 2026.11.07 or 2026.11.07-01), got "${current}"`);
  }
  const today = now.toISOString().slice(0, 10).replaceAll('-', '.');
  const [datePart, seq] = current.split('-');
  if (datePart < today) return today;
  if (!seq) return `${datePart}-01`;
  if (Number(seq) < 99) return `${datePart}-${String(Number(seq) + 1).padStart(2, '0')}`;
  const [year, month, day] = datePart.split('.').map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10).replaceAll('-', '.');
}

if (import.meta.main) {
  const VERSION_FILE = path.join(import.meta.dir, '..', 'api', 'VERSION');
  const next = nextAppVersion(fs.readFileSync(VERSION_FILE, 'utf8').trim());
  fs.writeFileSync(VERSION_FILE, `${next}\n`);
  console.log(next);
}
