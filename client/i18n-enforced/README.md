# i18n-enforced

Each `*.json` file here turns the lint rule `budget-i18n/no-untranslated-string`
on, as an error, for the files it lists. `eslint.config.js` reads every JSON in
this directory from disk and applies the rule to the union of all of them: you
never edit `eslint.config.js`. This README is ignored (only `.json` files count).

## Format

One file per converted package of the app, named after it (`payees.json`,
`plan-targets.json`, ...):

```json
{
  "files": ["src/features/payees/**/*.{ts,tsx}"],
  "ignores": ["src/features/payees/legacy/**"]
}
```

- `files` (required, non-empty): globs relative to `client/` (the directory of
  `eslint.config.js`). Always include both extensions: `**/*.{ts,tsx}`.
- `ignores` (optional): globs, same base, excluded from this manifest only.
  Use it for the files the "do not translate" list of `docs/i18n.md` covers,
  e.g. `src/features/import/parsers/**`.

Test files (`*.test.ts[x]`), `__fixtures__/` and `i18n/` directories are always
skipped by the rule itself; do not list them.

A malformed manifest fails the lint run with the file name in the message.

## Adding yours

1. Convert the strings of your package (recipe in `docs/i18n.md`).
2. Add `i18n-enforced/<package-id>.json` listing exactly the files you converted.
3. Run `bunx eslint .` in `client/`. Every remaining hit is either a string you
   missed or one that must not be translated: for the second kind add
   `// eslint-disable-next-line budget-i18n/no-untranslated-string -- <reason>`
   (the reason is required in review).

The rule also forbids importing `MONTH_ABBR`, `MONTH_NAMES`, `WEEKDAY_ABBR` in
enforced files: use `monthAbbr`, `monthName`, `weekdayAbbr` from
`@/domain/format`.
