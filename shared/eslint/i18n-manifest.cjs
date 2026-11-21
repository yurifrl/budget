/**
 * Reads the `i18n-enforced/*.json` manifests of a package and returns flat
 * ESLint config objects that turn `budget-i18n/no-untranslated-string` on for
 * the union of their file sets. A manifest is `{ "files": [globs], "ignores": [globs] }`,
 * globs relative to the package root (the directory of eslint.config.*).
 * See `<package>/i18n-enforced/README.md`.
 */
'use strict';

const { existsSync, readdirSync, readFileSync } = require('node:fs');
const path = require('node:path');

const plugin = require('./i18n-rule.cjs');

/** Parse and validate one manifest's text. Throws with the file name on a bad shape. */
function parseManifest(text, name) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new Error(`i18n-enforced/${name}: invalid JSON (${error.message})`);
  }
  const isGlobs = (v) => Array.isArray(v) && v.every((g) => typeof g === 'string');
  if (typeof data !== 'object' || data === null || !isGlobs(data.files) || data.files.length === 0) {
    throw new Error(`i18n-enforced/${name}: "files" must be a non-empty array of glob strings`);
  }
  if (data.ignores !== undefined && !isGlobs(data.ignores)) {
    throw new Error(`i18n-enforced/${name}: "ignores" must be an array of glob strings`);
  }
  return { files: data.files, ignores: data.ignores ?? [] };
}

/** Every manifest in `dir`, sorted by file name. A missing directory means none. */
function readManifests(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({ name: f, ...parseManifest(readFileSync(path.join(dir, f), 'utf8'), f) }));
}

/**
 * Flat-config entries enforcing the rule on each manifest's files. Several
 * entries enable the same rule as `error`, so the enforced set is their union.
 * `extraFiles` / `extraIgnores` are the package's own always-on set.
 */
function i18nConfigs(dir) {
  return readManifests(dir).map((m) => ({
    name: `budget-i18n/${m.name}`,
    files: m.files,
    ...(m.ignores.length > 0 ? { ignores: m.ignores } : {}),
    plugins: { 'budget-i18n': plugin },
    rules: { 'budget-i18n/no-untranslated-string': ['error', { forbidLegacyNames: true }] },
  }));
}

module.exports = { i18nConfigs, readManifests, parseManifest, plugin };
