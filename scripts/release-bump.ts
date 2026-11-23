/**
 * Release bump: move ONE release target's VERSION file to the next version
 * (today when older, the next same-day `-NN` suffix otherwise, the day after
 * only when the suffix is exhausted). Pattern: `YYYY.MM.DD[-NN]`.
 *
 * Targets (independent sequences, see docs/decisions.md 2026-11-23):
 *   api    -> `api/VERSION`: the server release (web, api, admin images, the
 *             k8s pin, /health, tag `v<VERSION>`). `task release`.
 *   client -> `client/VERSION`: the iOS app release (EAS build + App Store
 *             submit, tag `app-v<VERSION>`). `task release:app`.
 *
 * Committing and pushing is the caller's job: a push of a changed api/VERSION
 * triggers `.github/workflows/version.yml` (tags it, dispatches release.yml);
 * a push of a changed client/VERSION triggers `.github/workflows/app-release.yml`.
 *
 * Zero dependencies: `bun scripts/release-bump.ts api|client` runs with
 * nothing installed.
 */
import fs from 'node:fs';
import path from 'node:path';

export const APP_VERSION_PATTERN = /^\d{4}\.\d{2}\.\d{2}(-\d{2})?$/;

export const RELEASE_TARGETS = ['api', 'client'] as const;
export type ReleaseTarget = (typeof RELEASE_TARGETS)[number];

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

export function parseTarget(arg: string | undefined): ReleaseTarget {
  if (arg && (RELEASE_TARGETS as readonly string[]).includes(arg)) return arg as ReleaseTarget;
  throw new Error(`usage: bun scripts/release-bump.ts ${RELEASE_TARGETS.join('|')} (got ${arg ?? 'nothing'})`);
}

/** Bump `<root>/<target>/VERSION` in place and return the new version. Touches no other file. */
export function bumpTarget(root: string, target: ReleaseTarget, now: Date = new Date()): string {
  const file = path.join(root, target, 'VERSION');
  const next = nextAppVersion(fs.readFileSync(file, 'utf8').trim(), now);
  fs.writeFileSync(file, `${next}\n`);
  return next;
}

if (import.meta.main) {
  try {
    const target = parseTarget(process.argv[2]);
    console.log(bumpTarget(path.join(import.meta.dir, '..'), target));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
