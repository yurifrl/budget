# i18n-enforced

`client.json` turns the lint rule `budget-i18n/no-untranslated-string` on, as an
error, for all of `src/**/*.{ts,tsx}`. `eslint.config.js` reads every JSON in this
directory from disk (a README is ignored). New files are enforced from the start:
there is nothing to register.

## Format

- `files` (required, non-empty): globs relative to `client/` (the directory of
  `eslint.config.js`). Always include both extensions: `**/*.{ts,tsx}`.
- `ignores` (optional): globs, same base, excluded from this manifest only. They
  are exactly the "do not translate" files of `docs/i18n.md`: the import parsers
  (bank file header matching), `features/backup/transfer/tsv.ts` and `payload.ts`
  (archive format), `domain/revision.ts`, `ui/i18n/**`.

Test files (`*.test.ts[x]`), `__fixtures__/` and `i18n/` directories are always
skipped by the rule itself; do not list them.

A malformed manifest fails the lint run with the file name in the message.

For a string that must stay as it is (a brand name, a file format, a key name),
use `// eslint-disable-next-line budget-i18n/no-untranslated-string -- <reason>`;
the reason is required in review and never "this is UI text".

The rule also forbids importing `MONTH_ABBR`, `MONTH_NAMES`, `WEEKDAY_ABBR`: use
`monthAbbr`, `monthName`, `weekdayAbbr` from `@/domain/format`.
