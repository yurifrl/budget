/**
 * Statement dispatcher — routes a picked file by filename extension and
 * content (Contabilizei CSV, Nubank CSV, Itaú extrato TXT/XLS, generic CSV),
 * the way ynabu's parser does.
 */

import { detectContabilizeiCsv, parseContabilizeiCsv } from './contabilizei';
import { parseImportCsv } from './generic-csv';
import { parseItauExtratoTxt, parseItauExtratoXls, parseItauFaturaXls } from './itau';
import { detectNubankLayout, parseNubankCsv } from './nubank';
import type { ImportParseResult } from '@/domain/importTypes';

// ---------------------------------------------------------------------------
// Statement dispatcher: route by filename extension, like ynabu's parser
// ---------------------------------------------------------------------------
/** Supported statement extensions, for error messages and picker filters. */
export const STATEMENT_EXTENSIONS = ['.csv', '.txt', '.xls', '.xlsx'] as const;

/** Raw statement payload handed to {@link parseStatementFile}. */
export interface StatementData {
  /** Raw file bytes — XLS is binary BIFF8 and cannot be read as text. */
  bytes: Uint8Array;
  /** UTF-8 decoded text for the text formats (CSV / TXT). */
  text: string;
}

/**
 * Parse a picked statement file by its name: `.xls`/`.xlsx` → Itaú XLS
 * (fatura when the filename says so, account extrato otherwise), `.txt` →
 * Itaú extrato, everything else → CSV content sniffing: Contabilizei
 * (dedupe ids), Nubank conta/fatura, then the generic CSV parser. A
 * `fatura*` CSV is a credit-card bill whose positive amounts are charges
 * (parseImportCsv's `chargePositive`). OFX/QFX is rejected explicitly (by
 * extension and by content sniff, since bank exports frequently mislabel
 * their files).
 */
/** Real OFX/QFX SGML content (as opposed to the line-based legacy OFC). */
const OFX_SGML_RE = /<ofx[\s>]|<stmttrn>/i;
/** Legacy OFC: a run of short numeric header lines, then the account-id block. */
const LEGACY_OFC_ACCOUNT_RE = /^\d{1,6}(\r?\n\d{1,6}){1,6}\r?\n\r?\n\d{4,6}-?\d?\r?\n/m;

/**
 * Detect Itaú's legacy "1.0" OFC export (line-based SGML predecessor, values
 * on their own lines). Distinguished from any real SGML by the absence of
 * `<OFC>`/`<OFX>` tags plus the bank/account/amount line-block shape.
 */
function isLegacyOfc(text: string): boolean {
  if (/<ofx[\s>]|<ofc[\s>]|<stmttrn>/i.test(text)) return false;
  return LEGACY_OFC_ACCOUNT_RE.test(text);
}

export function parseStatementFile(name: string, data: StatementData): ImportParseResult {
  const lower = name.toLowerCase();
  const isFatura = lower.includes('fatura');
  if (lower.endsWith('.xls') || lower.endsWith('.xlsx')) {
    return isFatura ? parseItauFaturaXls(data.bytes) : parseItauExtratoXls(data.bytes);
  }
  const text = data.text;
  if (lower.endsWith('.txt')) return parseItauExtratoTxt(text);
  // OFX/QFX no longer accepted: the export quality doesn't justify the
  // parser (truncated date windows, SGML edge cases) — XLS/TXT cover Itaú.
  // Match by extension and by content, so mislabeled files also get the
  // honest rejection instead of a confusing CSV parse.
  if (lower.endsWith('.ofx') || lower.endsWith('.qfx') || OFX_SGML_RE.test(text)) {
    return {
      rows: [],
      skipped: 0,
      errors: ['OFX/QFX format is no longer supported — export the statement as XLS or TXT from Itaú instead'],
    };
  }
  // Legacy Itaú "1.0" OFC export: line-based values with no SGML tags
  // (`<OFC>`/`<STMTTRN>` absent, but the account/value blocks present). The
  // text path would misread it as a broken CSV — reject it explicitly.
  if (isLegacyOfc(text)) {
    return {
      rows: [],
      skipped: 0,
      errors: ['legacy binary OFC format is not supported — export the statement as XLS or TXT from Itaú instead'],
    };
  }
  // Contabilizei's header shares `Data`/`Descrição` with a Nubank conta
  // export, so it is checked first. Its rows go to the server id-less: the
  // bulk endpoint's YNAB fallback key dedupes re-imports.
  if (detectContabilizeiCsv(text)) return parseContabilizeiCsv(text);
  const nubankLayout = detectNubankLayout(text);
  if (nubankLayout) return parseNubankCsv(text, nubankLayout);
  const result = parseImportCsv(text, { chargePositive: isFatura });
  if (result.errors.length === 1 && result.errors[0] === 'unrecognized CSV layout') {
    return { ...result, errors: [`unrecognized file layout (supported: ${STATEMENT_EXTENSIONS.join(', ')})`] };
  }
  return result;
}
