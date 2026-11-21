# i18n-enforced

Each `*.json` file here turns the lint rule `budget-i18n/no-untranslated-string`
on, as an error, for the files it lists. `eslint.config.js` reads every JSON in
this directory from disk and applies the rule to the union of all of them: you
never edit `eslint.config.js`. This README is ignored (only `.json` files count).

## Format

```json
{
  "files": ["src/pages/**/*.{ts,tsx}"],
  "ignores": ["src/pages/legacy/**"]
}
```

- `files` (required, non-empty): globs relative to `admin/` (the directory of
  `eslint.config.js`). Include both extensions: `**/*.{ts,tsx}`.
- `ignores` (optional): globs, same base, excluded from this manifest only.

Test files (`*.test.ts[x]`), `__fixtures__/` and `i18n/` directories are always
skipped by the rule itself; do not list them.

Add `i18n-enforced/<package-id>.json` once your files are converted (recipe and
the full rule list: `docs/i18n.md`), then run `bunx eslint .` in `admin/`.
Escape hatch for a string that must stay as written:
`// eslint-disable-next-line budget-i18n/no-untranslated-string -- <reason>`.
