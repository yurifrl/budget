/**
 * Display text for the parsers' diagnostics. The parsers (`../parsers/**`) keep
 * their English strings: `parsedOutcome` and the tests match them. This only
 * maps the known shapes to translated sentences for the person; anything it
 * does not recognise is shown as the parser wrote it.
 */

import { t } from '../i18n';

const WHOLE: Record<string, () => string> = {
  'empty file': () => t('issue.empty'),
  'not a Nubank statement': () => t('issue.notNubank'),
  'unreadable XLS file': () => t('issue.unreadableXls'),
  'no data found in sheet': () => t('issue.noSheetData'),
  'no "lançamentos" section found in sheet — not an Itaú extrato XLS': () => t('issue.notItauXls'),
  'OFX/QFX format is no longer supported — export the statement as XLS or TXT from Itaú instead': () => t('issue.ofxUnsupported'),
  'legacy binary OFC format is not supported — export the statement as XLS or TXT from Itaú instead': () => t('issue.ofcUnsupported'),
};

const LINE_RE = /^line (\d+): (.*)$/s;
const QUOTED_RE = /^(unreadable date|unreadable amount) "(.*)"$/s;

/** One parser diagnostic as a sentence in the active language. */
export function parserMessage(raw: string): string {
  const whole = WHOLE[raw];
  if (whole) return whole();
  const lineMatch = LINE_RE.exec(raw);
  if (!lineMatch) return raw;
  const [, line, detail] = lineMatch;
  const quoted = QUOTED_RE.exec(detail);
  if (quoted) {
    return quoted[1] === 'unreadable date'
      ? t('issue.unreadableDate', { line, value: quoted[2] })
      : t('issue.unreadableAmount', { line, value: quoted[2] });
  }
  switch (detail) {
    case 'header has no date column':
      return t('issue.headerNoDate', { line });
    case 'bad date':
      return t('issue.badDate', { line });
    case 'no readable amount':
      return t('issue.noAmount', { line });
    case 'amount is zero':
      return t('issue.zeroAmount', { line });
    case 'expected "date;payee;value"':
      return t('issue.expectedFormat', { line });
    default:
      return raw;
  }
}
